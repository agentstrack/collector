import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  EXIT_UPDATED, compareVersions, installVersion, latestVersion, selfUpdatable,
} from './update.js';
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { readdirSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, saveConfig, SPOOL_PATH, LOG_PATH, type Config } from './config.js';
import { Spool } from './queue/spool.js';
import { machineInfo } from './machine.js';
import { tailFile } from './queue/tailer.js';
import { deterministicEventId } from './queue/event-id.js';
import { readOpenIslandRateLimits } from './adapters/open-island.js';
export { deterministicEventId };
import { ApiClient, ApiError, OrgPolicy, backoffMs, VERSION, type BatchResult, type ServerConfig } from './transport/client.js';
import { ClaudeCodeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { OpenCodeAdapter } from './adapters/opencode.js';
import { AntigravityAdapter } from './adapters/antigravity.js';
import { GeminiCliAdapter } from './adapters/gemini.js';
import { KimiCodeAdapter } from './adapters/kimi.js';
import type { AccountIdentity, AgentAdapter, NormalizedEvent } from './adapters/types.js';
import { applyPrivacy } from './privacy/pipeline.js';
import { compileRules, type RedactionRule } from './privacy/redact.js';
import { clampPrivacyMode } from './privacy/mode.js';
import { isExcluded } from './privacy/paths.js';
import { describeRepo } from './git/repo.js';
import { GitCommitWatcher } from './git/commits.js';
import { PRIVACY_MODES, SCHEMA_VERSION, type EventEnvelope, type PrivacyMode, type RepoContext } from './schema.js';

export { VERSION };

const LOG_MAX_BYTES = 5 * 1024 * 1024;

let verboseEnabled = false;

/** `--verbose`: counts, sizes and status codes only — never payloads, prompts, paths or keys. */
export function setVerbose(on: boolean): void {
  verboseEnabled = on;
}

/** A diagnostic line, written only under `--verbose` (to the log and to stderr). */
export function verbose(message: string): void {
  if (!verboseEnabled) return;
  log(message);
  console.error(`[verbose] ${message}`);
}

/**
 * A privacy mode from an untrusted source (server response, persisted meta).
 * Anything unrecognised is the strictest mode: an unknown policy is no licence.
 */
export function toPrivacyMode(value: unknown): PrivacyMode {
  return (PRIVACY_MODES as readonly unknown[]).includes(value) ? (value as PrivacyMode) : 'metadata';
}

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
  return allAdapters(config).filter((a) => config.tracking.agents.includes(a.id));
}

/** Every agent id this build knows, for validating `start --agent`. */
export function knownAgentIds(config: Config): string[] {
  return allAdapters(config).map((a) => a.id);
}

function allAdapters(config: Config): AgentAdapter[] {
  // OpenCode and Antigravity read databases, not files, so max_age_days
  // reaches them through their constructors rather than the transcript walk.
  return [
    new ClaudeCodeAdapter(),
    new CodexAdapter(),
    new OpenCodeAdapter(undefined, config.tracking.max_age_days),
    new AntigravityAdapter(undefined, config.tracking.max_age_days),
    new GeminiCliAdapter(),
    new KimiCodeAdapter(),
  ];
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
 * Event types newer than the servers this collector may talk to. Each is sent
 * only when GET /v1/collector/config lists it in `event_types`: a batch the
 * server rejects in full pauses the whole upload (`reason: 'schema'`), so an
 * older backend must never be handed one. Unknown config means "not listed".
 */
export const GATED_EVENT_TYPES = new Set(['rate_limit.reported']);

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

  // Every directory is visited once, by its real path. ~/.claude/projects
  // has been seen holding a `projects -> .` symlink, which made the walk
  // re-read every transcript under up to five aliases (one per depth level).
  const visited = new Set<string>();
  const walk = (current: string, depth: number) => {
    if (depth > 5 || !existsSync(current)) return;
    let real: string;
    try {
      real = realpathSync(current);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
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
  /** 413, or a 400/422 on a multi-event batch: halve and retry, so only a bad event ends up struck. */
  | { kind: 'split'; why: 'too_large' | 'rejected' }
  | { kind: 'retry'; error: unknown; retryAfterMs?: number }
  | { kind: 'poison'; error: unknown }
  | { kind: 'paused'; reason: PauseReason; detail: string };

/** Waves one daemon tick may send before scan() gets the loop back. */
/** How often the daemon asks the registry whether a newer release exists. */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const MAX_WAVES_PER_TICK = 5;

/** Spool meta key naming the current upload pause (`<reason>: <detail>`); `status` prints it. */
export const UPLOAD_PAUSE_META = 'upload_paused_reason';

/**
 * Spool meta key holding the last org policy fetched (`{privacy_mode,
 * redaction_rules}` as JSON), so a boot with no network still clamps to it.
 */
export const ORG_POLICY_META = 'org_policy';

/** How often a known server config is re-fetched; how soon an unknown one is retried. */
const CONFIG_TTL_MS = 10 * 60_000;
const CONFIG_RETRY_MS = 60_000;

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
  /** The mode the user configured. `config.privacy.mode` is this clamped to the org ceiling. */
  private readonly localMode: PrivacyMode;
  private configAttemptAt = 0;
  private warnedConfig = false;
  /**
   * Whether an org policy — fetched, or persisted from an earlier fetch — is
   * in force. Privacy is applied at enqueue, so until one is, a registered
   * device neither tails nor uploads: an event spooled under the looser local
   * mode would be sent at that mode after the ceiling arrived.
   */
  private policyKnown = false;
  private warnedNoPolicy = false;
  /** git root -> last branch seen, for git.branch_changed. Per process: the first read is never a change. */
  private readonly lastBranch = new Map<string, string>();
  /** Event types enqueued during the current scan, for `--verbose`. */
  private readonly scanCounts = new Map<string, number>();
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
  /** Warn-once flags: these states are normal and must not spam the log. */
  private warnedNotUpdatable = false;
  private warnedAttempted = false;
  /** `sync --dry-run`: scans a throwaway spool, so its scan tallies must not reach the real log. */
  private readonly dryRun: boolean;

  constructor(
    private config: Config,
    deps: { spool?: Spool; client?: Transport; dryRun?: boolean } = {},
  ) {
    this.dryRun = deps.dryRun ?? false;
    if (!config.api_key) throw new Error('Not logged in. Run: agentstrack login <api-key>');
    this.spool = deps.spool ?? new Spool(SPOOL_PATH);
    this.client = deps.client ?? new ApiClient({ apiUrl: config.api_url, apiKey: config.api_key });
    this.adapters = buildAdapters(config);
    this.commitWatcher = config.tracking.git_metadata
      ? new GitCommitWatcher({ excluded: config.privacy.excluded_projects })
      : null;
    this.batchSize = config.upload.batch_size;
    this.maxBatchSize = config.upload.batch_size;
    // Until the server answers, the last org policy it gave is still the
    // ceiling. Never fetched and nothing persisted (or persisted unreadably):
    // no policy, so scan() and flush() hold until the first fetch succeeds.
    this.localMode = config.privacy.mode;
    const persisted = this.persistedPolicy();
    if (persisted) this.applyOrgPolicy(persisted);
  }

  async start(): Promise<void> {
    this.running = true;
    await this.ensureRegistered();
    await this.refreshServerConfig();
    this.reconcileIfBackendChanged();

    log(`Collector ${VERSION} started — agents: ${this.adapters.map((a) => a.id).join(', ')}`);

    const scanInterval = 5_000;
    const uploadInterval = this.config.upload.interval_seconds * 1000;
    let lastUpload = 0;
    let lastHealth = 0;
    // Checked shortly after boot rather than immediately: a machine waking up
    // with no network would otherwise burn its one attempt on a failed fetch,
    // and an update is never urgent enough to race the network coming up.
    let lastUpdateCheck = Date.now() - UPDATE_CHECK_INTERVAL_MS + 60_000;

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
        if (now - lastUpdateCheck >= UPDATE_CHECK_INTERVAL_MS) {
          lastUpdateCheck = now;
          await this.maybeSelfUpdate();
        }
      } catch (error) {
        log(`Upload error: ${errorMessage(error)}`);
      }

      // A backlog alternates scan and flush without the 5s pause between them.
      await sleep(more ? 0 : scanInterval);
    }
  }

  /**
   * A backend this spool has not uploaded to holds none of its history, so
   * the checkpoints — which only ever meant "already sent" — are meaningless
   * against it. Forget them once and let the normal scan re-read everything;
   * the server keeps what it lacks and reports the rest as duplicates.
   *
   * This is the automatic half of reconciliation, and it fires on exactly the
   * case that motivated it: `login` against a different deployment. Before
   * this, pointing a collector at a new backend uploaded only what happened
   * *after* the switch, and every earlier session stayed on disk looking
   * uploaded — silent, and invisible until someone counted rows.
   *
   * Keyed on api_url + collector_id together: the id alone changes on a
   * re-login to the same server (harmless, but a needless re-upload), and the
   * url alone misses one deployment restoring another's database.
   */
  private reconcileIfBackendChanged(): void {
    const backend = `${this.config.api_url}\n${this.config.collector_id ?? ''}`;
    const seen = this.spool.getMeta('uploaded_backend');
    if (seen === backend) return;

    if (seen === null) {
      // First run of this spool. Checkpoints cannot be stale against a backend
      // nothing was ever sent to, so record and move on — re-reading here
      // would make every fresh install start with a full backfill it does not
      // need.
      this.spool.setMeta('uploaded_backend', backend);
      return;
    }

    const cleared = this.spool.clearCheckpoints();
    this.spool.setMeta('uploaded_backend', backend);
    log(
      `Backend changed — reconciling: cleared ${cleared} read checkpoint(s), ` +
        'every transcript will be re-read and anything this backend is missing re-sent ' +
        '(already-known events come back as duplicates and are not stored twice).',
    );
  }

  /**
   * Install a newer release and exit so the supervisor starts it.
   *
   * Everything here fails soft. A collector that cannot update must still
   * collect, so an unreachable registry, a refused install or a missing npm
   * are all logged and shrugged off — the running version keeps working.
   */
  private async maybeSelfUpdate(): Promise<void> {
    if (!this.config.auto_update) return;

    const here = fileURLToPath(import.meta.url);
    const updatable = selfUpdatable(here);
    if (!updatable.ok) {
      // Once per process, not once per check: this is the normal state on a
      // developer's machine and does not need repeating every six hours.
      if (!this.warnedNotUpdatable) {
        this.warnedNotUpdatable = true;
        log(`Auto-update skipped — ${updatable.reason}.`);
      }
      return;
    }

    const latest = await latestVersion();
    if (!latest || compareVersions(latest, VERSION) <= 0) return;

    // One attempt per version, remembered across restarts. Without this, a
    // release that installs but cannot start would exit non-zero on every
    // boot and burn systemd's StartLimitBurst, taking the service down for
    // good over a bad publish.
    const attempted = this.spool.getMeta('update_attempted');
    if (attempted === latest) {
      if (!this.warnedAttempted) {
        this.warnedAttempted = true;
        log(`Auto-update: ${latest} was already attempted and did not take — staying on ${VERSION}.`);
      }
      return;
    }
    this.spool.setMeta('update_attempted', latest);

    log(`Auto-update: ${VERSION} -> ${latest}, installing…`);
    let installed: string | null = null;
    try {
      installed = await installVersion(latest);
    } catch (error) {
      log(`Auto-update failed to install ${latest}: ${errorMessage(error)} — staying on ${VERSION}.`);
      return;
    }

    if (installed !== latest) {
      log(`Auto-update: install reported ${installed ?? 'nothing'}, expected ${latest} — staying on ${VERSION}.`);
      return;
    }

    // Flush first. The spool survives a restart, but sending what we already
    // have costs one request and means an update never widens the window
    // where recent work is only on this disk.
    try {
      await this.flush(MAX_WAVES_PER_TICK);
    } catch {
      // Not worth aborting the update over; the spool keeps the events.
    }

    log(`Auto-update: installed ${latest}, exiting ${EXIT_UPDATED} so the service restarts into it.`);
    this.running = false;
    this.stop();
    // Non-zero on purpose: both supervisors restart on failure and treat a
    // clean exit as "meant to stop". This is the documented way back up.
    process.exit(EXIT_UPDATED);
  }

  stop(): void {
    this.running = false;
    // No session.ended here: SIGTERM, an auto-update restart and the end of
    // `sync --full` are not the developer ending a session, and an end stamped
    // now would cut every open session short. The idle timeout ends them.
    this.spool.close();
  }

  /** Registers this device once and remembers the id. */
  private async ensureRegistered(): Promise<void> {
    if (this.config.collector_id) return;

    const agents = await Promise.all(
      this.adapters.map(async (a) => ({ agent: a.id, version: (await a.detect()).version })),
    );
    const result = await this.client.registerCollector({
      ...machineInfo(),
      version: VERSION,
      // Report what this device enforces, so a session records the mode that
      // actually applied rather than the org default.
      privacy_mode: this.config.privacy.mode,
      agents,
    });

    this.config = { ...this.config, collector_id: result.collector_id };
    // Only the registration over what is on disk: the in-memory config carries
    // the org-clamped mode and any `start --agent` override, neither of which
    // the user saved.
    saveConfig({ ...loadConfig(), collector_id: result.collector_id });
    log(`Registered collector ${result.collector_id}`);
  }

  /**
   * The org policy from the last successful fetch, validated with the same
   * schema as the fetch. Null when none was stored or it is unreadable — an
   * unknown policy, which holds collection until the server answers.
   */
  private persistedPolicy(): OrgPolicy | null {
    const raw = this.spool.getMeta(ORG_POLICY_META);
    if (raw === null) return null;
    try {
      const parsed = OrgPolicy.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** False, logged once, while a registered device has no org policy in force. */
  private holdUntilPolicy(): boolean {
    if (this.policyKnown || !this.config.collector_id) return false;
    if (!this.warnedNoPolicy) {
      this.warnedNoPolicy = true;
      log('No org policy yet (server config never fetched) — not reading or uploading until it is');
    }
    return true;
  }

  private applyOrgPolicy(policy: OrgPolicy): void {
    // Compiled once per config refresh, not once per event.
    this.orgRules = compileRules(policy.redaction_rules, log);
    // The org sets a ceiling; a stricter local mode is honoured, a looser one
    // is not. Same rule as `login`, shared so the two cannot drift.
    const effective = clampPrivacyMode(this.localMode, toPrivacyMode(policy.privacy_mode));
    if (effective !== this.config.privacy.mode && effective !== this.localMode) {
      log(`Local privacy mode '${this.localMode}' exceeds org policy '${effective}' — using org policy`);
    }
    this.config = { ...this.config, privacy: { ...this.config.privacy, mode: effective } };
    this.policyKnown = true;
  }

  /** Re-fetches the server config on a TTL, sooner while it is still unknown. */
  private async maybeRefreshServerConfig(): Promise<void> {
    const wait = this.serverConfig ? CONFIG_TTL_MS : CONFIG_RETRY_MS;
    if (Date.now() - this.configAttemptAt >= wait) await this.refreshServerConfig();
  }

  private async refreshServerConfig(): Promise<void> {
    this.configAttemptAt = Date.now();
    try {
      this.serverConfig = await this.client.getConfig();
      this.applyOrgPolicy(this.serverConfig);
      this.spool.setMeta(
        ORG_POLICY_META,
        JSON.stringify({
          privacy_mode: this.serverConfig.privacy_mode,
          redaction_rules: this.serverConfig.redaction_rules,
        }),
      );
      if (this.warnedConfig) log('Server config fetched — org policy applied');
      this.warnedConfig = false;
      // The server's ceiling wins over the local batch_size; anything above it
      // is a guaranteed 413 on every wave.
      const serverMax = this.serverConfig.max_batch_events;
      if (Number.isInteger(serverMax) && serverMax > 0) {
        this.maxBatchSize = Math.min(this.config.upload.batch_size, serverMax);
        this.batchSize = Math.min(this.batchSize, this.maxBatchSize);
      }
    } catch (error) {
      // Once per outage: an offline laptop retries every minute.
      if (!this.warnedConfig) {
        this.warnedConfig = true;
        const basis = this.policyKnown ? 'using the last known org policy' : 'holding collection until it can be';
        log(`Could not fetch server config, ${basis}: ${errorMessage(error)}`);
      }
    }
  }

  /** One pass over every tracked transcript file. */
  /**
   * One scan pass, for callers that are not the daemon loop — `sync --full`
   * needs the transcripts read before there is anything to upload.
   */
  async scanOnce(): Promise<void> {
    // Fetched first, so a one-shot scan applies the org policy it would have
    // on the daemon rather than whatever the local file says.
    if (this.config.collector_id) await this.refreshServerConfig();
    await this.scan();
  }

  private async scan(): Promise<void> {
    const collectorId = this.config.collector_id;
    if (!collectorId) return;
    await this.maybeRefreshServerConfig();
    // Nothing read means no checkpoint moves: the same lines are read, and
    // clamped, once the policy is known.
    if (this.holdUntilPolicy()) return;

    this.repoCache.clear();
    this.scanCounts.clear();
    let queued = 0;
    let files = 0;
    let skipped = 0;
    let dropped = 0;
    // A file the tailer stopped short of EOF: a backfill is in progress, so a
    // session's "last activity" is wherever the read has got to, not when it
    // actually went quiet.
    let backfilling = false;

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
              // Before the commit watcher, which an unattributable event must not arm either.
              const kept = this.dropUnattributable(normalized);
              dropped += normalized.length - kept.length;
              this.commitWatcher?.observe(kept);
              queued += this.enqueue(kept, collectorId, account);
            });
            if (result.lines > 0) files += 1;
            if (result.more) backfilling = true;
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
          const polled = await this.pollAdapter(adapter.poll.bind(adapter), collectorId, account);
          queued += polled.queued;
          dropped += polled.dropped;
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

    if (this.config.tracking.open_island_rate_limits) queued += this.reportOpenIslandRateLimits();

    if (!backfilling) {
      queued += this.endIdleSessions(this.config.tracking.idle_timeout_seconds * 1000, 'timeout');
    }

    if (!this.dryRun) {
      if (queued > 0) log(`Queued ${queued} events across ${files} files`);
      if (skipped > 0) log(`Skipped ${skipped} oversized transcript lines`);
      if (dropped > 0) log(`Dropped ${dropped} events with no known project while excluded_projects is set`);
    }
    if (this.scanCounts.size > 0) {
      verbose(`Scan queued: ${[...this.scanCounts].map(([type, n]) => `${type}=${n}`).join(' ')}`);
    }
  }

  /**
   * Fails closed on excluded projects: a transcript event whose project is
   * unknown cannot be shown not to come from one, so while any exclusion is
   * configured it is dropped rather than sent.
   */
  private dropUnattributable(items: NormalizedEvent[]): NormalizedEvent[] {
    if (this.config.privacy.excluded_projects.length === 0) return items;
    return items.filter((item) => Boolean(item.cwd ?? item.repo?.project_path));
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
  ): Promise<{ queued: number; dropped: number }> {
    const pending = new Map<string, string>();
    const polled = await poll({
      collectorId,
      getMeta: (key) => pending.get(key) ?? this.spool.getMeta(key),
      setMeta: (key, value) => void pending.set(key, value),
    });
    // The same fail-closed exclusion as the tail path, before the commit watcher.
    const kept = this.dropUnattributable(polled);
    this.commitWatcher?.observe(kept);
    const queued = this.spool.transaction(() => {
      const n = this.enqueue(kept, collectorId, account);
      pending.forEach((value, key) => this.spool.setMeta(key, value));
      return n;
    });
    return { queued, dropped: polled.length - kept.length };
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
    // A copy: a branch change is spliced in right after the event that saw it.
    const queue = [...items];

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i]!;
      const type = item.event.event_type;
      if (GATED_EVENT_TYPES.has(type) && !this.serverConfig?.event_types?.includes(type)) continue;

      const cwd = item.cwd;
      // An excluded project never produces an event at all — whichever of
      // cwd or the adapter's repo path names it.
      const project = cwd ?? item.repo?.project_path;
      if (project && isExcluded(project, this.config.privacy.excluded_projects)) continue;

      const repo = cwd && this.config.tracking.git_metadata ? this.repoFor(cwd) : item.repo;
      if (cwd && repo?.branch && repo.project_path && this.config.tracking.git_metadata) {
        const changed = this.branchChange(repo.project_path, repo.branch, item);
        if (changed) queue.splice(i + 1, 0, changed);
      }
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
      this.scanCounts.set(event.event_type, (this.scanCounts.get(event.event_type) ?? 0) + 1);
    }

    return this.spool.enqueue(envelopes);
  }

  /**
   * git.branch_changed when this repo's branch differs from the last read.
   * Nothing on the first sighting of a repo: a restart is not a checkout.
   */
  private branchChange(root: string, to: string, trigger: NormalizedEvent): NormalizedEvent | null {
    const from = this.lastBranch.get(root);
    this.lastBranch.set(root, to);
    if (from === undefined || from === to) return null;
    const { occurred_at, session_id, agent, agent_version } = trigger.event;
    return {
      event: { occurred_at, session_id, agent, agent_version, event_type: 'git.branch_changed', payload: { from, to } },
      cwd: trigger.cwd,
      eventId: deterministicEventId(`git.branch_changed\n${root}\n${from}\n${to}\n${session_id}\n${occurred_at}`),
    };
  }

  /** mtime of the Open Island file last reported, so an unchanged file is read but not re-sent. */
  private openIslandMtimeMs = 0;

  /**
   * Attaches Open Island's Claude plan windows to the most recently active
   * Claude Code session — the file names no session or account, so that is
   * the best available owner, and the server labels it advisory. No live
   * Claude session means nothing is sent.
   */
  private reportOpenIslandRateLimits(path?: string): number {
    const collectorId = this.config.collector_id;
    if (!collectorId) return 0;
    const reading = readOpenIslandRateLimits(path);
    if (!reading || reading.mtimeMs === this.openIslandMtimeMs) return 0;
    let owner: OpenSession | undefined;
    for (const s of this.openSessions.values()) {
      if (s.agent === 'claude_code' && (!owner || s.lastAtMs > owner.lastAtMs)) owner = s;
    }
    if (!owner) return 0;
    this.openIslandMtimeMs = reading.mtimeMs;
    return this.enqueue(
      [
        {
          event: {
            occurred_at: new Date(reading.mtimeMs).toISOString(),
            session_id: owner.sessionId,
            agent: 'claude_code',
            agent_version: owner.agentVersion,
            event_type: 'rate_limit.reported',
            payload: { source: 'open_island', windows: reading.windows },
          },
          eventId: deterministicEventId(`rate_limit\nopen_island\n${owner.sessionId}\n${reading.mtimeMs}`),
        },
      ],
      collectorId,
    );
  }

  private trackSession(event: EventEnvelope): void {
    // A plan-window reading is not activity: Open Island rewrites its file on
    // any Claude session's status line, and counting that would keep a quiet
    // session open for ever.
    if (event.event_type === 'rate_limit.reported') return;
    const key = `${event.agent}::${event.session_id}`;
    if (event.event_type === 'session.ended') {
      this.openSessions.delete(key);
      return;
    }
    // A duration-carrying event is start-stamped and ran until start + duration:
    // that end, not the stamp, is the session's last activity.
    const duration = event.payload['duration_ms'];
    const at = Date.parse(event.occurred_at) + (typeof duration === 'number' && Number.isFinite(duration) ? duration : 0);
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
    if (this.holdUntilPolicy()) return false;
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

      verbose(`Upload wave: ${batches.length} batch(es) of ${batches.map((b) => b.length).join('/')} events`);
      let allOk = true;
      let split = null as 'too_large' | 'rejected' | null;
      /** The largest batch that asked to be split: halving starts from it, not from the configured size. */
      let splitFrom = 0;
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
        if (outcome.kind === 'split') {
          split ??= outcome.why;
          splitFrom = Math.max(splitFrom, batches[i]!.length);
        }
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

      if (split) {
        // Too big for the server (the events are fine), or one bad event
        // failing its whole batch: halve until the bad one is alone and struck.
        this.batchSize = Math.max(1, Math.floor(splitFrom / 2));
        log(
          `Server rejected the batch ${split === 'too_large' ? 'as too large' : 'as invalid'} — reducing batch size to ${this.batchSize}`,
        );
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
      verbose(
        `Batch of ${batch.length} -> 200 (accepted ${result.accepted}, duplicates ${result.duplicates}, rejected ${result.rejected.length})`,
      );
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
      verbose(`Batch of ${batch.length} -> ${error.status === 0 ? 'network error' : `HTTP ${error.status}`}`);
      // The key is revoked or lacks ingest: the events are fine, the login is not.
      if (error.status === 401 || error.status === 403) return { kind: 'paused', reason: 'auth', detail: error.message };
      // Too big for the server but the events are fine — unless it is a
      // single event, which then really is unacceptable.
      if (error.status === 413) return batch.length > 1 ? { kind: 'split', why: 'too_large' } : { kind: 'poison', error };
      if (error.retryable) return { kind: 'retry', error, retryAfterMs: error.retryAfterMs };
      // A validation failure names the whole request; it may be one event's fault.
      if ((error.status === 400 || error.status === 422) && batch.length > 1) return { kind: 'split', why: 'rejected' };
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
    if (!this.pausedReason) {
      // A pause an earlier process recorded and this one never saw.
      if (this.spool.getMeta(UPLOAD_PAUSE_META) !== null) this.spool.deleteMeta(UPLOAD_PAUSE_META);
      return;
    }
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
        ...machineInfo(),
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
  const message = error instanceof Error ? error.message : String(error);
  // fetch's abort on our own timeout reads as if someone cancelled it.
  return /operation was aborted/i.test(message) ? 'request timed out' : message;
}

export { loadConfig };
