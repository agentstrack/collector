import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { hostname, arch, platform } from 'node:os';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, saveConfig, SPOOL_PATH, LOG_PATH, type Config } from './config.js';
import { Spool } from './queue/spool.js';
import { tailFile } from './queue/tailer.js';
import { ApiClient, backoffMs, type ServerConfig } from './transport/client.js';
import { ClaudeCodeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import type { AgentAdapter, NormalizedEvent } from './adapters/types.js';
import { applyPrivacy } from './privacy/pipeline.js';
import { clampPrivacyMode } from './privacy/mode.js';
import { isExcluded } from './privacy/paths.js';
import { describeRepo } from './git/repo.js';
import { GitCommitWatcher } from './git/commits.js';
import { SCHEMA_VERSION, type EventEnvelope } from './schema.js';

export function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    // Logging must never take the collector down.
  }
}

export function buildAdapters(config: Config): AgentAdapter[] {
  const all: AgentAdapter[] = [new ClaudeCodeAdapter(), new CodexAdapter()];
  return all.filter((a) => config.tracking.agents.includes(a.id));
}

/** Recursively lists .jsonl files under a directory, newest first. */
export function listTranscripts(dir: string, maxAgeDays = 7): string[] {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const found: { path: string; mtime: number }[] = [];

  const walk = (current: string, depth: number) => {
    if (depth > 5 || !existsSync(current)) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return; // unreadable directory is skipped, not fatal
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) walk(full, depth + 1);
      else if (entry.endsWith('.jsonl') && stats.mtimeMs >= cutoff) {
        found.push({ path: full, mtime: stats.mtimeMs });
      }
    }
  };

  walk(dir, 0);
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.path);
}

export class Collector {
  private readonly spool: Spool;
  private readonly client: ApiClient;
  private readonly adapters: AgentAdapter[];
  /** Null when git metadata is switched off — then we never shell out to git. */
  private readonly commitWatcher: GitCommitWatcher | null;
  private serverConfig: ServerConfig | null = null;
  private uploadFailures = 0;
  /** Shrinks on 413, recovers on success. Never below 1. */
  private batchSize: number;
  private running = false;

  constructor(private config: Config) {
    if (!config.api_key) throw new Error('Not logged in. Run: agentstrack login <api-key>');
    this.spool = new Spool(SPOOL_PATH);
    this.client = new ApiClient({ apiUrl: config.api_url, apiKey: config.api_key });
    this.adapters = buildAdapters(config);
    this.commitWatcher = config.tracking.git_metadata ? new GitCommitWatcher() : null;
    this.batchSize = config.upload.batch_size;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.ensureRegistered();
    await this.refreshServerConfig();

    log(`Collector started — agents: ${this.adapters.map((a) => a.id).join(', ')}`);

    const scanInterval = 5_000;
    const uploadInterval = this.config.upload.interval_seconds * 1000;
    let lastUpload = 0;
    let lastHealth = 0;

    while (this.running) {
      try {
        await this.scan();
      } catch (error) {
        log(`Scan error: ${errorMessage(error)}`);
      }

      const now = Date.now();
      if (now - lastUpload >= uploadInterval || this.spool.depth() >= this.batchSize) {
        lastUpload = now;
        await this.flush();
      }
      if (now - lastHealth >= 60_000) {
        lastHealth = now;
        await this.reportHealth();
      }

      await sleep(scanInterval);
    }
  }

  stop(): void {
    this.running = false;
    this.spool.close();
  }

  /** Registers this device once and remembers the id. */
  private async ensureRegistered(): Promise<void> {
    if (this.config.collector_id) return;

    const agents = await Promise.all(
      this.adapters.map(async (a) => ({ agent: a.id, version: (await a.detect()).version })),
    );
    const result = await this.client.registerCollector({
      hostname: hostname(),
      os: platform(),
      arch: arch(),
      version: VERSION,
      // Report what this device enforces, so a session records the mode that
      // actually applied rather than the org default.
      privacy_mode: this.config.privacy.mode,
      agents,
    });

    this.config = { ...this.config, collector_id: result.collector_id };
    saveConfig(this.config);
    log(`Registered collector ${result.collector_id}`);
  }

  private async refreshServerConfig(): Promise<void> {
    try {
      this.serverConfig = await this.client.getConfig();
      // The org sets a ceiling; a stricter local mode is honoured, a looser one
      // is not. Same rule as `login`, shared so the two cannot drift.
      const effective = clampPrivacyMode(this.config.privacy.mode, this.serverConfig.privacy_mode);
      if (effective !== this.config.privacy.mode) {
        log(`Local privacy mode '${this.config.privacy.mode}' exceeds org policy '${this.serverConfig.privacy_mode}' — using org policy`);
        this.config = { ...this.config, privacy: { ...this.config.privacy, mode: effective } };
      }
    } catch (error) {
      log(`Could not fetch server config, using local defaults: ${errorMessage(error)}`);
    }
  }

  /** One pass over every tracked transcript file. */
  private async scan(): Promise<void> {
    const collectorId = this.config.collector_id;
    if (!collectorId) return;

    for (const adapter of this.adapters) {
      const detection = await adapter.detect();
      if (!detection.installed) continue;

      for (const watchPath of detection.watchPaths) {
        for (const file of listTranscripts(watchPath)) {
          const { lines } = await tailFile(file, this.spool);
          if (lines.length === 0) continue;

          const normalized: NormalizedEvent[] = [];
          for (const line of lines) {
            try {
              normalized.push(...adapter.normalize(line, { collectorId, sourceFile: file }));
            } catch (error) {
              // A parser bug on one line must not stop the whole file.
              log(`normalize error in ${file}: ${errorMessage(error)}`);
            }
          }
          this.commitWatcher?.observe(normalized);
          this.enqueue(normalized, collectorId);
        }
      }
    }

    // Commits are the strongest session -> PR signal (§13) and no agent logs
    // them, so they are read from git itself — one `git log` per repo a session
    // actually touched, once per scan cycle.
    if (this.commitWatcher) {
      try {
        this.enqueue(await this.commitWatcher.poll(), collectorId);
      } catch (error) {
        log(`Commit scan error: ${errorMessage(error)}`);
      }
    }
  }

  private enqueue(normalized: NormalizedEvent[], collectorId: string): void {
    const envelopes: EventEnvelope[] = [];

    for (const item of normalized) {
      const cwd = item.cwd;
      // An excluded project never produces an event at all.
      if (cwd && isExcluded(cwd, this.config.privacy.excluded_projects)) continue;

      const repo = cwd && this.config.tracking.git_metadata ? describeRepo(cwd) : item.repo;
      const payload = repo ? { ...item.event.payload, repo: { ...repo, ...(item.event.payload['repo'] as object ?? {}) } } : item.event.payload;

      const envelope: EventEnvelope = {
        ...item.event,
        payload,
        event_id: randomUUID(),
        schema_version: SCHEMA_VERSION,
        collector_id: collectorId,
      };

      const { event } = applyPrivacy(envelope, {
        config: this.config,
        projectRoot: repo?.project_path,
        orgRules: this.serverConfig?.redaction_rules,
      });
      envelopes.push(event);
    }

    const written = this.spool.enqueue(envelopes);
    if (written > 0) log(`Queued ${written} events (depth ${this.spool.depth()})`);
  }

  /** Drains the spool, oldest first, until it is empty or the server pushes back. */
  async flush(): Promise<void> {
    for (;;) {
      const batch = this.spool.peek(this.batchSize);
      if (batch.length === 0) {
        this.uploadFailures = 0;
        return;
      }

      try {
        const result = await this.client.sendBatch(batch.map((b) => b.event));
        // Duplicates are acknowledged too — the server already has them.
        this.spool.ack(batch.map((b) => b.eventId));
        this.uploadFailures = 0;
        // Creep back up after a shrink so one huge session does not permanently
        // halve throughput.
        if (this.batchSize < this.config.upload.batch_size) {
          this.batchSize = Math.min(this.config.upload.batch_size, this.batchSize * 2);
        }

        if (result.rejected.length > 0) {
          log(`Server rejected ${result.rejected.length} events: ${result.rejected[0]?.reason ?? ''}`);
        }
        log(`Uploaded ${result.accepted} events (${result.duplicates} duplicates)`);
      } catch (error) {
        const status = error instanceof Error && 'status' in error ? Number(error.status) : 0;

        // 413: the batch is too big for the server, but the events are fine.
        // Halve and retry rather than treat real telemetry as poison.
        if (status === 413 && this.batchSize > 1) {
          this.batchSize = Math.max(1, Math.floor(this.batchSize / 2));
          log(`Server rejected the batch as too large — reducing batch size to ${this.batchSize}`);
          return;
        }

        const retryable = error instanceof Error && 'retryable' in error ? Boolean(error.retryable) : true;
        if (!retryable) {
          // The server will never accept these; count strikes so a poison
          // batch cannot block the queue indefinitely.
          const dropped = this.spool.fail(batch.map((b) => b.eventId), this.config.upload.max_retries);
          log(`Batch permanently rejected: ${errorMessage(error)}${dropped ? ` (dropped ${dropped})` : ''}`);
          return;
        }
        this.uploadFailures += 1;
        const wait = backoffMs(this.uploadFailures);
        log(`Upload failed (attempt ${this.uploadFailures}), retrying in ${Math.round(wait / 1000)}s: ${errorMessage(error)}`);
        await sleep(wait);
        return;
      }
    }
  }

  private async reportHealth(): Promise<void> {
    if (!this.config.collector_id) return;
    try {
      const agents = await Promise.all(
        this.adapters.map(async (a) => ({ agent: a.id, version: (await a.detect()).version })),
      );
      await this.client.health({
        collector_id: this.config.collector_id,
        queue_depth: this.spool.depth(),
        version: VERSION,
        privacy_mode: this.config.privacy.mode,
        agents,
      });
    } catch (error) {
      log(`Health report failed: ${errorMessage(error)}`);
    }
  }

  queueDepth(): number {
    return this.spool.depth();
  }
}

export const VERSION = '0.1.0';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { loadConfig };
