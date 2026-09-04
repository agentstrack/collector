import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { hostname, arch, platform } from 'node:os';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, saveConfig, SPOOL_PATH, LOG_PATH, type Config } from './config.js';
import { Spool } from './queue/spool.js';
import { tailFile } from './queue/tailer.js';
import { deterministicEventId } from './queue/event-id.js';
export { deterministicEventId };
import { ApiClient, ApiError, backoffMs, VERSION, type BatchResult, type ServerConfig } from './transport/client.js';
import { ClaudeCodeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { OpenCodeAdapter } from './adapters/opencode.js';
import type { AccountIdentity, AgentAdapter, NormalizedEvent } from './adapters/types.js';
import { applyPrivacy } from './privacy/pipeline.js';
import { compileRules, type RedactionRule } from './privacy/redact.js';
import { clampPrivacyMode } from './privacy/mode.js';
import { isExcluded } from './privacy/paths.js';
import { describeRepo } from './git/repo.js';
import { GitCommitWatcher } from './git/commits.js';
import { SCHEMA_VERSION, type EventEnvelope, type RepoContext } from './schema.js';

export { VERSION };

const LOG_MAX_BYTES = 5 * 1024 * 1024;

export function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    // One rotation, no compression: enough to keep a service's log bounded
    // without making `tail -f` lose the current file.
    if ((statSync(LOG_PATH, { throwIfNoEntry: false })?.size ?? 0) > LOG_MAX_BYTES) {
      renameSync(LOG_PATH, `${LOG_PATH}.1`);
    }
    appendFileSync(LOG_PATH, line);
  } catch {
    // Logging must never take the collector down.
  }
}

export function buildAdapters(config: Config): AgentAdapter[] {
  // OpenCode reads a database, not files, so max_age_days reaches it through
  // its constructor rather than through the transcript walk.
  const all: AgentAdapter[] = [
    new ClaudeCodeAdapter(),
    new CodexAdapter(),
    new OpenCodeAdapter(undefined, config.tracking.max_age_days),
  ];
  return all.filter((a) => config.tracking.agents.includes(a.id));
}

/**
 * Event types that carry account attribution.
 *
 * Session start pins the whole session to an account; a prompt pins the turn.
 * Every other event inherits that on the server, so repeating it on each of
 * them would only add bytes and more places for the identity to leak from.
 */
const ACCOUNT_EVENTS = new Set(['session.started', 'user.prompted']);

/**
 * Whether this event may carry account attribution.
 *
 * The honest half is the timestamp. ~/.claude.json and account.json record who
 * is signed in NOW and keep no history, so an event written before this
 * collector started — a transcript already on disk at first run, or anything
 * from a window when the daemon was down — cannot be attributed. It gets NO
 * account rather than today's account, which would be a plausible-looking lie.
 */
export function attributable(eventType: string, occurredAt: string, liveSinceMs: number): boolean {
  if (!ACCOUNT_EVENTS.has(eventType)) return false;
  const at = Date.parse(occurredAt);
  return Number.isFinite(at) && at >= liveSinceMs;
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

/** Splits one peeked wave into `batchSize` slices, every event in exactly one. */
export function chunkWave<T>(wave: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < wave.length; i += batchSize) batches.push(wave.slice(i, i + batchSize));
  return batches;
}

type PauseReason = 'auth' | 'quota' | 'schema';

/**
 * What one batch request came back as. Pure data: the policy — halving,
 * backing off, dropping — runs once per wave in flush(), never inside the
 * concurrent sends, so four failing siblings cannot each escalate it.
 */
type BatchOutcome =
  | { kind: 'ok'; result: BatchResult }
  | { kind: 'too_large' }
  | { kind: 'retry'; error: unknown; retryAfterMs?: number }
  | { kind: 'poison'; error: unknown }
  | { kind: 'paused'; reason: PauseReason; detail: string };

/** Waves one daemon tick may send before scan() gets the loop back. */
const MAX_WAVES_PER_TICK = 5;

/** Spool meta key naming the current upload pause (`<reason>: <detail>`); `status` prints it. */
export const UPLOAD_PAUSE_META = 'upload_paused_reason';

/** The subset of ApiClient the daemon uses — a test hands in a fake. */
type Transport = Pick<ApiClient, 'registerCollector' | 'getConfig' | 'sendBatch' | 'health'>;

interface OpenSession {
  agent: EventEnvelope['agent'];
  agentVersion?: string;
  sessionId: string;
  lastAtMs: number;
}

export class Collector {
  private readonly spool: Spool;
  private readonly client: Transport;
  private readonly adapters: AgentAdapter[];
  /** Null when git metadata is switched off — then we never shell out to git. */
  private readonly commitWatcher: GitCommitWatcher | null;
  private serverConfig: ServerConfig | null = null;
  private orgRules: RedactionRule[] = [];
  /**
   * When this collector started, and therefore the earliest event it can
   * honestly attribute to an account.
   *
   * Account files record only who is signed in NOW. A transcript that was
   * already on disk when the collector first ran was written by whoever was
   * signed in at the time, which we cannot know — so backfilled events carry
   * NO account rather than today's account. Live events, written while we were
   * watching, do carry one. The same rule covers a restart: the gap while the
   * collector was down is backfill.
   */
  private readonly liveSinceMs = Date.now();
  private uploadFailures = 0;
  /** Shrinks on 413, recovers on success. Never below 1, never above maxBatchSize. */
  private batchSize: number;
  /** Local batch_size clamped to the server's max_batch_events. */
  private maxBatchSize: number;
  /** Uploads are gated on this instead of sleeping, so scanning never stops. */
  private nextUploadAt = 0;
  private pausedReason: PauseReason | null = null;
  /** cwd -> repo, valid for one scan pass. */
  private readonly repoCache = new Map<string, RepoContext | undefined>();
  /** agent::session_id -> last activity, for idle session.ended. */
  private readonly openSessions = new Map<string, OpenSession>();
  private running = false;

  constructor(
    private config: Config,
    deps: { spool?: Spool; client?: Transport } = {},
  ) {
    if (!config.api_key) throw new Error('Not logged in. Run: agentstrack login <api-key>');
    this.spool = deps.spool ?? new Spool(SPOOL_PATH);
    this.client = deps.client ?? new ApiClient({ apiUrl: config.api_url, apiKey: config.api_key });
    this.adapters = buildAdapters(config);
    this.commitWatcher = config.tracking.git_metadata ? new GitCommitWatcher() : null;
    this.batchSize = config.upload.batch_size;
    this.maxBatchSize = config.upload.batch_size;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.ensureRegistered();
    await this.refreshServerConfig();

    log(`Collector ${VERSION} started — agents: ${this.adapters.map((a) => a.id).join(', ')}`);

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
      let more = false;
      try {
        if (now >= this.nextUploadAt && (now - lastUpload >= uploadInterval || this.spool.depth() >= this.batchSize)) {
          lastUpload = now;
          more = await this.flush(MAX_WAVES_PER_TICK);
        }
        if (now - lastHealth >= 60_000) {
          lastHealth = now;
          await this.reportHealth();
        }
      } catch (error) {
        log(`Upload error: ${errorMessage(error)}`);
      }

      // A backlog alternates scan and flush without the 5s pause between them.
      await sleep(more ? 0 : scanInterval);
    }
  }

  stop(): void {
    this.running = false;
    // Whatever was open when we went down ended for a reason we cannot see.
    if (this.config.collector_id) this.endIdleSessions(0, 'unknown');
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
      // Compiled once per config refresh, not once per event.
      this.orgRules = compileRules(this.serverConfig.redaction_rules);
      // The org sets a ceiling; a stricter local mode is honoured, a looser one
      // is not. Same rule as `login`, shared so the two cannot drift.
      const effective = clampPrivacyMode(this.config.privacy.mode, this.serverConfig.privacy_mode);
      if (effective !== this.config.privacy.mode) {
        log(`Local privacy mode '${this.config.privacy.mode}' exceeds org policy '${this.serverConfig.privacy_mode}' — using org policy`);
        this.config = { ...this.config, privacy: { ...this.config.privacy, mode: effective } };
      }
      // The server's ceiling wins over the local batch_size; anything above it
      // is a guaranteed 413 on every wave.
      const serverMax = this.serverConfig.max_batch_events;
      if (Number.isInteger(serverMax) && serverMax > 0) {
        this.maxBatchSize = Math.min(this.config.upload.batch_size, serverMax);
        this.batchSize = Math.min(this.batchSize, this.maxBatchSize);
      }
    } catch (error) {
      log(`Could not fetch server config, using local defaults: ${errorMessage(error)}`);
    }
  }

  /** One pass over every tracked transcript file. */
  private async scan(): Promise<void> {
    const collectorId = this.config.collector_id;
    if (!collectorId) return;

    this.repoCache.clear();
    let queued = 0;
    let files = 0;
    let skipped = 0;

    for (const adapter of this.adapters) {
      const detection = await adapter.detect();
      if (!detection.installed) continue;

      // Read once per cycle, not once at boot: the user may have switched
      // accounts since the last scan.
      const account = adapter.account?.();

      for (const watchPath of detection.watchPaths) {
        for (const file of listTranscripts(watchPath, this.config.tracking.max_age_days)) {
          // One unreadable file must not stall every other file, every scan.
          try {
            const result = await tailFile(file, this.spool, (lines) => {
              const normalized: NormalizedEvent[] = [];
              for (const { text, offset } of lines) {
                let events: NormalizedEvent[];
                try {
                  events = adapter.normalize(text, { collectorId, sourceFile: file });
                } catch (error) {
                  // A parser bug on one line must not stop the whole file.
                  log(`normalize error in ${file}: ${errorMessage(error)}`);
                  continue;
                }
                if (events.length === 0) continue;
                // Same file, same byte, same text => same id, however often it is re-read.
                const line = createHash('sha256').update(`${adapter.id}\n${file}\n${offset}\n`).update(text).digest('hex');
                events.forEach((event, i) =>
                  normalized.push({ ...event, eventId: event.eventId ?? deterministicEventId(`${line}:${i}`) }),
                );
              }
              this.commitWatcher?.observe(normalized);
              queued += this.enqueue(normalized, collectorId, account);
            });
            if (result.lines > 0) files += 1;
            skipped += result.skipped;
          } catch (error) {
            log(`tail error in ${file}: ${errorMessage(error)}`);
          }
        }
      }

      // Database-backed agents have no lines to tail; they hand us events on
      // the same cycle, under the same gating and the same privacy pipeline.
      if (adapter.poll) {
        try {
          queued += await this.pollAdapter(adapter.poll.bind(adapter), collectorId, account);
        } catch (error) {
          log(`poll error in ${adapter.id}: ${errorMessage(error)}`);
        }
      }
    }

    // Commits are the strongest session -> PR signal (§13) and no agent logs
    // them, so they are read from git itself — one `git log` per repo a session
    // actually touched, once per scan cycle.
    if (this.commitWatcher) {
      try {
        queued += this.enqueue(await this.commitWatcher.poll(), collectorId);
      } catch (error) {
        log(`Commit scan error: ${errorMessage(error)}`);
      }
    }

    queued += this.endIdleSessions(this.config.tracking.idle_timeout_seconds * 1000, 'timeout');

    if (queued > 0) log(`Queued ${queued} events across ${files} files`);
    if (skipped > 0) log(`Skipped ${skipped} oversized transcript lines`);
  }

  /**
   * Polls a database-backed adapter. Its cursors and "already started" markers
   * are buffered and written in the same transaction as the events — an
   * enqueue that fails (SQLITE_FULL) must not leave a cursor pointing past
   * rows that were never spooled, or a session marked started that never was.
   */
  private async pollAdapter(
    poll: NonNullable<AgentAdapter['poll']>,
    collectorId: string,
    account: AccountIdentity | undefined,
  ): Promise<number> {
    const pending = new Map<string, string>();
    const polled = await poll({
      collectorId,
      getMeta: (key) => pending.get(key) ?? this.spool.getMeta(key),
      setMeta: (key, value) => void pending.set(key, value),
    });
    this.commitWatcher?.observe(polled);
    return this.spool.transaction(() => {
      const queued = this.enqueue(polled, collectorId, account);
      pending.forEach((value, key) => this.spool.setMeta(key, value));
      return queued;
    });
  }

  /**
   * Emits session.ended for every tracked session quiet for longer than
   * `idleMs`. Claude Code and Codex never write an end marker, so without this
   * their sessions stay in_progress on the server forever. `occurred_at` is
   * when the timeout elapsed, not now: a backfilled session ended back then.
   */
  private endIdleSessions(idleMs: number, reason: 'timeout' | 'unknown'): number {
    const collectorId = this.config.collector_id;
    if (!collectorId) return 0;
    const now = Date.now();
    const ended: NormalizedEvent[] = [];
    for (const [key, s] of this.openSessions) {
      if (now - s.lastAtMs < idleMs) continue;
      this.openSessions.delete(key);
      const at = idleMs > 0 ? s.lastAtMs + idleMs : now;
      ended.push({
        event: {
          occurred_at: new Date(at).toISOString(),
          session_id: s.sessionId,
          agent: s.agent,
          agent_version: s.agentVersion,
          event_type: 'session.ended',
          payload: { external_session_id: s.sessionId, reason },
        },
        eventId: deterministicEventId(`session.ended\n${s.agent}\n${s.sessionId}\n${s.lastAtMs}`),
      });
    }
    return this.enqueue(ended, collectorId);
  }

  private repoFor(cwd: string): RepoContext | undefined {
    if (!this.repoCache.has(cwd)) this.repoCache.set(cwd, describeRepo(cwd));
    return this.repoCache.get(cwd);
  }

  private enqueue(items: NormalizedEvent[], collectorId: string, adapterAccount?: AccountIdentity): number {
    const envelopes: EventEnvelope[] = [];

    for (const item of items) {
      const cwd = item.cwd;
      // An excluded project never produces an event at all.
      if (cwd && isExcluded(cwd, this.config.privacy.excluded_projects)) continue;

      const repo = cwd && this.config.tracking.git_metadata ? this.repoFor(cwd) : item.repo;
      const payload: Record<string, unknown> = repo
        ? { ...item.event.payload, repo: { ...repo, ...(item.event.payload['repo'] as object ?? {}) } }
        : { ...item.event.payload };

      // The adapter's per-event identity wins: OpenCode knows which provider
      // account a given session ran on, which adapter.account() cannot.
      const account = item.account ?? adapterAccount;

      // Plan type rides with the usage, not with the account block: the server
      // reads it off the token-bearing event to decide cost basis. Without it a
      // flat-rate subscriber's spend is labelled "estimated at API list rates",
      // which reads as a bill they never received.
      if (
        account?.planType &&
        (item.event.event_type === 'usage.reported' || item.event.event_type === 'model.response')
      ) {
        payload['plan_type'] = account.planType;
      }

      if (account && attributable(item.event.event_type, item.event.occurred_at, this.liveSinceMs)) {
        payload['account'] = account;
      }

      const envelope: EventEnvelope = {
        ...item.event,
        payload,
        event_id: item.eventId ?? randomUUID(),
        schema_version: SCHEMA_VERSION,
        collector_id: collectorId,
      };

      const { event } = applyPrivacy(envelope, {
        config: this.config,
        projectRoot: repo?.project_path,
        compiledRules: this.orgRules,
      });
      envelopes.push(event);
      this.trackSession(event);
    }

    return this.spool.enqueue(envelopes);
  }

  private trackSession(event: EventEnvelope): void {
    const key = `${event.agent}::${event.session_id}`;
    if (event.event_type === 'session.ended') {
      this.openSessions.delete(key);
      return;
    }
    const at = Date.parse(event.occurred_at);
    if (!Number.isFinite(at)) return;
    const open = this.openSessions.get(key);
    if (open) {
      open.lastAtMs = Math.max(open.lastAtMs, at);
      return;
    }
    this.openSessions.set(key, {
      agent: event.agent,
      agentVersion: event.agent_version,
      sessionId: event.session_id,
      lastAtMs: at,
    });
  }

  /**
   * Drains the spool, one wave of `upload.concurrency` batches at a time.
   *
   * Uploading is round-trip bound, not bandwidth bound — a first import moved
   * ~330 events/s sequentially, which is one 100-event batch per ~300ms of
   * mostly waiting — so sending several at once divides the wall clock of a
   * backfill by roughly that number. Order is deliberately NOT preserved
   * across in-flight batches: the server derives a session's start from
   * min(recorded start, earliest stored event), so a later batch landing first
   * is corrected once the rest arrive. Within a batch the spool still yields
   * oldest-first.
   *
   * The failure policy runs ONCE per wave, on the collected outcomes:
   *  - any 413        -> batch size halves once
   *  - any retryable  -> one backoff step; uploads are gated on nextUploadAt,
   *                      never slept on, so tailing continues meanwhile
   *  - any poison     -> strikes for those batches only
   *  - 401/403, quota, whole-batch schema rejection -> paused, nothing dropped
   *  - every batch ok -> counter reset, batch size creeps back up
   *
   * Returns true when it stopped only because `maxWaves` ran out, i.e. there
   * is more to send right now.
   */
  async flush(maxWaves = Number.POSITIVE_INFINITY): Promise<boolean> {
    const concurrency = Math.max(1, this.config.upload.concurrency);
    for (let n = 0; n < maxWaves; n++) {
      // One peek for the whole wave. Peeking per batch would hand the same
      // rows to every request, because nothing is acked until they return.
      const wave = this.spool.peek(this.batchSize * concurrency);
      if (wave.length === 0) {
        this.uploadFailures = 0;
        this.resume();
        return false;
      }
      const batches = chunkWave(wave, this.batchSize);

      // allSettled, not all: one failing batch must not abandon its siblings,
      // whose events are already accepted by the server.
      const settled = await Promise.allSettled(batches.map((b) => this.sendBatch(b)));

      let allOk = true;
      let tooLarge = false;
      // `null as` keeps the declared union: a plain `= null` narrows to never below.
      let retry = null as { error: unknown; retryAfterMs: number } | null;
      let paused = null as { reason: PauseReason; detail: string } | null;
      let accepted = 0;
      let duplicates = 0;

      const outcomes: BatchOutcome[] = settled.map((s) =>
        s.status === 'fulfilled' ? s.value : { kind: 'retry', error: s.reason },
      );
      for (const [i, outcome] of outcomes.entries()) {
        const ids = batches[i]!.map((b) => b.eventId);
        if (outcome.kind === 'ok') {
          // Duplicates are acknowledged too — the server already has them.
          this.spool.ack(ids);
          accepted += outcome.result.accepted;
          duplicates += outcome.result.duplicates;
          if (outcome.result.rejected.length > 0) {
            log(`Server rejected ${outcome.result.rejected.length} events: ${outcome.result.rejected[0]?.reason ?? ''}`);
          }
          continue;
        }
        allOk = false;
        if (outcome.kind === 'too_large') tooLarge = true;
        else if (outcome.kind === 'retry') {
          retry = {
            error: retry?.error ?? outcome.error,
            retryAfterMs: Math.max(retry?.retryAfterMs ?? 0, outcome.retryAfterMs ?? 0),
          };
        } else if (outcome.kind === 'poison') {
          // The server will never accept these; count strikes so a poison
          // batch cannot block the queue indefinitely.
          const dropped = this.spool.fail(ids, this.config.upload.max_retries);
          log(`Batch permanently rejected: ${errorMessage(outcome.error)}${dropped ? ` (dropped ${dropped})` : ''}`);
        } else paused ??= outcome;
      }

      if (accepted + duplicates > 0) log(`Uploaded ${accepted} events (${duplicates} duplicates)`);

      if (tooLarge) {
        // The batch is too big for the server, but the events are fine.
        this.batchSize = Math.max(1, Math.floor(this.batchSize / 2));
        log(`Server rejected the batch as too large — reducing batch size to ${this.batchSize}`);
      }
      if (paused) {
        this.pause(paused);
        return false;
      }
      if (retry !== null) {
        this.uploadFailures += 1;
        const wait = Math.max(backoffMs(this.uploadFailures), retry.retryAfterMs);
        this.nextUploadAt = Date.now() + wait;
        log(`Upload failed (attempt ${this.uploadFailures}), retrying in ${Math.round(wait / 1000)}s: ${errorMessage(retry.error)}`);
        return false;
      }
      // Settings just changed (413) or strikes were counted: re-enter on the
      // next tick rather than keep draining with the old shape.
      if (!allOk) return false;

      this.uploadFailures = 0;
      this.resume();
      // Creep back up after a shrink so one huge session does not permanently
      // halve throughput.
      if (this.batchSize < this.maxBatchSize) {
        this.batchSize = Math.min(this.maxBatchSize, this.batchSize * 2);
      }
    }
    return true;
  }

  /** Sends one batch and reports what happened. Touches no shared state. */
  private async sendBatch(batch: ReturnType<Spool['peek']>): Promise<BatchOutcome> {
    try {
      const result = await this.client.sendBatch(batch.map((b) => b.event));
      const nothingTaken = result.accepted === 0 && result.duplicates === 0 && result.rejected.length >= batch.length;
      if (nothingTaken) {
        // The server said 200 but kept nothing. Acking would delete telemetry
        // it never stored: an over-quota org (retry next month, not never) or
        // a collector whose schema the server no longer understands.
        if (result.quota?.exceeded) {
          return {
            kind: 'paused',
            reason: 'quota',
            detail: `monthly event quota exceeded (${result.quota.used ?? '?'}/${result.quota.limit ?? '?'})`,
          };
        }
        // One event the server would not take is that event's fault, not a
        // collector-wide schema drift: strike it, do not pause the queue.
        if (batch.length === 1) return { kind: 'poison', error: new Error(result.rejected[0]?.reason ?? 'rejected') };
        return {
          kind: 'paused',
          reason: 'schema',
          detail: `server rejected every event (${result.rejected[0]?.reason ?? ''}) — collector ${VERSION} may be out of date`,
        };
      }
      return { kind: 'ok', result };
    } catch (error) {
      if (!(error instanceof ApiError)) return { kind: 'retry', error };
      // The key is revoked or lacks ingest: the events are fine, the login is not.
      if (error.status === 401 || error.status === 403) return { kind: 'paused', reason: 'auth', detail: error.message };
      // Too big for the server but the events are fine — unless it is a
      // single event, which then really is unacceptable.
      if (error.status === 413) return batch.length > 1 ? { kind: 'too_large' } : { kind: 'poison', error };
      if (error.retryable) return { kind: 'retry', error, retryAfterMs: error.retryAfterMs };
      return { kind: 'poison', error };
    }
  }

  /** Backs off and records why, once per reason, where `agentstrack status` can read it. */
  private pause(p: { reason: PauseReason; detail: string }): void {
    this.uploadFailures += 1;
    this.nextUploadAt = Date.now() + backoffMs(this.uploadFailures);
    if (this.pausedReason !== p.reason) {
      this.pausedReason = p.reason;
      log(`Uploads paused (${p.reason}): ${p.detail}`);
    }
    this.spool.setMeta(UPLOAD_PAUSE_META, `${p.reason}: ${p.detail}`);
  }

  private resume(): void {
    if (!this.pausedReason) return;
    log(`Uploads resumed after ${this.pausedReason} pause`);
    this.pausedReason = null;
    this.spool.deleteMeta(UPLOAD_PAUSE_META);
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

  /** Upload policy state, for tests and diagnostics. */
  uploadState(): { failures: number; batchSize: number; nextUploadAt: number; paused: PauseReason | null } {
    return {
      failures: this.uploadFailures,
      batchSize: this.batchSize,
      nextUploadAt: this.nextUploadAt,
      paused: this.pausedReason,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { loadConfig };
