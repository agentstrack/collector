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
