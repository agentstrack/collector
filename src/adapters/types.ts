import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EventEnvelope, RepoContext } from '../schema.js';

export interface DetectionResult {
  installed: boolean;
  version?: string;
  /** Directories the tailer should watch. */
  watchPaths: string[];
  note?: string;
}

export interface HealthStatus {
  healthy: boolean;
  filesTracked: number;
  lastEventAt?: string;
  error?: string;
}

/**
 * Per-agent adapter (BLUEPRINT §9.2).
 *
 * Note there is no installHooks(): the collector reads the agent's own log
 * files rather than injecting itself into the agent's config. That keeps us
 * out of files other tools also own, and the logs carry token counts that
 * hooks never deliver.
 */
export interface AgentAdapter {
  readonly id: string;
  detect(): Promise<DetectionResult>;
  health(): Promise<HealthStatus>;
  /**
   * Converts one raw log line into zero or more normalized events.
   * MUST NOT throw on unrecognised input — agents change their formats between
   * releases, and one unknown line must not stop the file.
   */
  normalize(line: string, ctx: NormalizeContext): NormalizedEvent[];
  /**
   * Optional pull-based source, for agents that keep state in a database
   * instead of an append-only log.
   *
   * normalize() is line-oriented and there are no lines in a SQLite file, so
   * rather than pretend otherwise these adapters produce their events by
   * polling. The daemon drives poll() on the same scan cycle as the tailer,
   * with the same `tracking.agents` gating and the same excluded_projects
   * filter applied to what comes back. Resumption is the adapter's own
   * problem — the tailer's (path, inode, offset) checkpoint means nothing to a
   * database, so PollContext hands it the spool's meta store instead.
   */
  poll?(ctx: PollContext): Promise<NormalizedEvent[]>;
  /**
   * The account this agent is signed in as RIGHT NOW, or undefined when the
   * agent is logged out or exposes no stable id.
   *
   * Called once per scan cycle, not once at boot: these files are rewritten in
   * place when the user switches accounts.
   */
  account?(): AccountIdentity | undefined;
}

/**
 * Non-PII account attribution, attached by the daemon to session.started and
 * user.prompted.
 *
 * `key` is opaque and stable and always travels — it is what makes sessions
 * split per account. `label` and `org` identify a person and their employer
 * and are stripped by the privacy pipeline below `analytics` mode.
 */
export interface AccountIdentity {
  /** Subscription/plan signal, when the agent exposes one. Drives cost basis. */
  planType?: string;
  key: string;
  label?: string;
  org?: string;
  provider?: string;
}

export interface PollContext {
  collectorId: string;
  /** The spool's meta store: a database adapter's resume cursor lives here. */
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

export interface NormalizeContext {
  collectorId: string;
  /** Path of the file this line came from, for session grouping. */
  sourceFile: string;
}

/** An event plus the side-channel facts the session tracker needs. */
export interface NormalizedEvent {
  event: Omit<EventEnvelope, 'event_id' | 'collector_id' | 'schema_version'>;
  cwd?: string;
  repo?: RepoContext;
  /**
   * Account this specific event belongs to, when the adapter can pin it down
   * more precisely than adapter.account() can — OpenCode holds one active
   * account per provider, so the answer differs between two sessions on the
   * same machine. Takes precedence over adapter.account().
   */
  account?: AccountIdentity;
  /**
   * The id to spool the event under, when the adapter knows a seed more
   * durable than "this line at this offset" — a message id that repeats
   * across lines, say. Absent: the daemon derives one from the source line.
   */
  eventId?: string;
}

export function safeJsonParse(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    // Partial line from a file still being written; the tailer will retry.
    return null;
  }
}

export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Head-of-file lines cached on (path, mtime) — see readHeadLines. */
const headCache = new Map<string, { mtimeMs: number; lines: string[] }>();

/**
 * The complete lines within the first `bytes` of a file.
 *
 * detect() runs every scan cycle and only needs a version string that sits on
 * the first line, so reading the whole transcript (13 MB for a live Codex
 * rollout) for it was pure churn. Same (path, mtime) cache as account.ts.
 */
export function readHeadLines(path: string, bytes = 16_384): string[] {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    headCache.delete(path);
    return [];
  }
  const hit = headCache.get(path);
  if (hit && hit.mtimeMs === stats.mtimeMs) return hit.lines;

  let lines: string[] = [];
  try {
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const read = readSync(fd, buffer, 0, bytes, 0);
      lines = buffer.toString('utf8', 0, read).split('\n');
      if (read === bytes) lines.pop(); // the last line was cut by the window
    } finally {
      closeSync(fd);
    }
  } catch {
    // Unreadable file: absent is better than fabricated.
  }
  headCache.set(path, { mtimeMs: stats.mtimeMs, lines });
  return lines;
}

/** Newest `.jsonl` in a directory by mtime, not by readdir order. */
export function newestJsonl(dir: string): string | undefined {
  let best: { path: string; mtimeMs: number } | undefined;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    try {
      const { mtimeMs } = statSync(path);
      if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
    } catch {
      // Removed between readdir and stat.
    }
  }
  return best?.path;
}
