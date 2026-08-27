import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
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
export const Config = z.object({
  api_url: z.string().url().default('https://api.agentstrack.ai'),
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
    .default({}),

  tracking: z
    .object({
      idle_timeout_seconds: z.number().int().min(30).max(3600).default(120),
      git_metadata: z.boolean().default(true),
      process_metrics: z.boolean().default(true),
      agents: z.array(z.string()).default(['claude_code', 'codex']),
    })
    .default({}),

  upload: z
    .object({
      batch_size: z.number().int().min(1).max(500).default(100),
      interval_seconds: z.number().int().min(5).max(600).default(30),
      max_retries: z.number().int().min(0).max(20).default(8),
    })
    .default({}),
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
  writeFileSync(CONFIG_PATH, stringify(config), 'utf8');
  // The file holds an API key.
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
#   analytics - adds locally generated session titles; raw content discarded
#   full      - uploads prompt text (opt-in, off by default)
`;
