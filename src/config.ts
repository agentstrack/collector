import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { PRIVACY_MODES } from './schema.js';

export const CONFIG_DIR = process.env['AGENTSTRACK_HOME'] ?? join(homedir(), '.agentstrack');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml');
export const SPOOL_PATH = join(CONFIG_DIR, 'spool.db');
export const LOG_PATH = join(CONFIG_DIR, 'collector.log');
export const PID_PATH = join(CONFIG_DIR, 'collector.pid');

/**
 * On-disk config. Shape follows BLUEPRINT §9.4 so the documented example is
 * literally valid.
 */
/**
 * Where a collector talks to AgentsTrack unless told otherwise.
 *
 * `api.` rather than the apex: the dashboard routes `/v1` on `agentstrack.ai`
 * so its session cookie stays same-origin, but a collector authenticates with
 * an API key and has no cookie to keep, so it uses the host meant for it.
 */
export const DEFAULT_API_URL = 'https://api.agentstrack.ai';

export const Config = z.object({
  api_url: z
    .string()
    .url()
    // The API key travels as a bearer token on every request, so the transport
    // must be encrypted. http is allowed only for a loopback dev server.
    .refine(
      (u) =>
        u.startsWith('https://') ||
        /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(u),
      'api_url must be https (http is allowed only for localhost)',
    )
    .default(DEFAULT_API_URL),
  /** Written by `agentstrack login`. File is chmod 600. */
  api_key: z.string().optional(),
  collector_id: z.string().uuid().optional(),

  privacy: z
    .object({
      mode: z.enum(PRIVACY_MODES).default('analytics'),
      prompts: z.enum(['never', 'local_summary_only', 'full']).default('local_summary_only'),
      code_content: z.enum(['never', 'full']).default('never'),
      file_paths: z.enum(['never', 'relative', 'absolute']).default('relative'),
      shell_arguments: z.enum(['never', 'redact_secrets', 'full']).default('redact_secrets'),
      excluded_projects: z.array(z.string()).default([]),
    })
    // zod 4: every key here already has its own .default(), so the object
    // schema's *input* type is `{}` (all-optional) but its parsed type is
    // fully populated — .default() now types against the input, .prefault()
    // (pre-parse default) is the zod4 replacement for this shape.
    .prefault({}),

  tracking: z
    .object({
      /**
       * How far back to scan for transcript files, by file mtime.
       *
       * 7 days is the steady-state default: a running collector only needs to
       * notice files the agents are still writing, and widening the walk costs
       * a stat() per file on every scan.
       *
       * It is also what made a first import silently partial — a new install
       * uploaded the last week and left years of history on disk with no
       * indication anything had been skipped. Raise it to import that history
       * (`max_age_days: 3650`), then put it back.
       */
      max_age_days: z.number().int().min(1).max(3650).default(7),
      idle_timeout_seconds: z.number().int().min(30).max(3600).default(120),
      git_metadata: z.boolean().default(true),
      process_metrics: z.boolean().default(true),
      agents: z.array(z.string()).default(['claude_code', 'codex', 'opencode']),
    })
    .prefault({}),

  upload: z
    .object({
      batch_size: z.number().int().min(1).max(500).default(100),
      interval_seconds: z.number().int().min(5).max(600).default(30),
      max_retries: z.number().int().min(0).max(20).default(8),
      /**
       * Batches uploaded at once.
       *
       * Uploading is round-trip bound, not bandwidth bound: a backfill of
       * ~80k events moved at ~330 events/s sequentially, which is one 100-event
       * batch per ~300ms of mostly waiting. Sending several at once turns the
       * first import of a laptop's history from tens of minutes into a few.
       *
       * Safe because arrival order does not matter: the server derives a
       * session's start from min(recorded start, earliest event) and re-runs
       * reconstruction after every batch, so a later batch landing first is
       * corrected once the rest arrive.
       *
       * Capped at 8 to stay well inside the server's ingest bucket (6000
       * requests/minute) even with several machines importing at once.
       */
      concurrency: z.number().int().min(1).max(8).default(4),
    })
    .prefault({}),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return Config.parse({});
  try {
    return Config.parse(parse(readFileSync(CONFIG_PATH, 'utf8')) ?? {});
  } catch (error) {
    // A hand-edited config that no longer parses must not silently revert to
    // defaults — that could quietly widen the privacy mode.
    throw new Error(
      `Config at ${CONFIG_PATH} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  // Atomic + owner-only from the moment it exists: write a 0600 temp file, then
  // rename it over the target. A crash mid-write can no longer leave a
  // truncated (unparseable) config or a brief window where the key is
  // world-readable at the umask default.
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, stringify(config), { mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
  chmodSync(CONFIG_PATH, 0o600);
}

/**
 * Creates ~/.agentstrack as owner-only.
 *
 * The directory holds an API key, a spool of telemetry and a log. At the
 * default umask those are world-readable, which on a shared host hands every
 * other user a developer's session history.
 */
export function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(CONFIG_DIR, 0o700);
  } catch {
    // Pre-existing directory owned by someone else — nothing useful to do.
  }
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

/** Documented starting point, written on `agentstrack login`. */
export const DEFAULT_CONFIG_COMMENT = `# AgentsTrack collector configuration
# Docs: https://github.com/agentstrack/collector#configuration
#
# privacy.mode:
#   metadata  - counts and timings only; no titles, no prompts, no code
#   analytics - adds a session title (the first line of the prompt, max 120
#               chars, secret-redacted); raw prompt text discarded
#   full      - uploads prompt text (opt-in, off by default)
`;
