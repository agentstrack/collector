import { z } from 'zod';

/**
 * AgentsTrack telemetry envelope, schema v1.
 *
 * This file is the collector's copy of the wire contract, documented in
 * docs/EVENT_SCHEMA.md. The server holds the canonical EVENT_SCHEMA.json and
 * validates against the same shape; `npm test` includes a contract test that
 * asserts the two agree whenever the server repo is checked out alongside
 * this one (or AGENTSTRACK_SERVER_REPO points at it).
 *
 * Note what is NOT here: organization_id and user_id. The server derives both
 * from your API key. A collector cannot name its own tenant, by design.
 */
export const SCHEMA_VERSION = 1;

export const AGENTS = [
  'claude_code', 'codex', 'gemini_cli', 'opencode', 'cursor', 'cline', 'copilot_cli', 'antigravity', 'kimi_code', 'other',
] as const;
export type AgentId = (typeof AGENTS)[number];

export const EVENT_TYPES = [
  'session.started', 'session.ended', 'user.prompted',
  'agent.turn.started', 'agent.turn.ended',
  'model.request', 'model.response',
  'tool.started', 'tool.completed', 'tool.failed',
  'file.read', 'file.changed', 'command.executed',
  'git.commit', 'git.branch_changed',
  'usage.reported', 'error', 'heartbeat',
  'rate_limit.reported',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const PRIVACY_MODES = ['metadata', 'analytics', 'full'] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export const emptyUsage = (): TokenUsage => ({
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
});

export const EventEnvelope = z.object({
  event_id: z.string().uuid(),
  schema_version: z.literal(SCHEMA_VERSION),
  occurred_at: z.string(),
  collector_id: z.string().uuid(),
  session_id: z.string().min(1).max(200),
  agent: z.enum(AGENTS),
  agent_version: z.string().max(50).optional(),
  event_type: z.enum(EVENT_TYPES),
  // zod 4 requires an explicit key schema for z.record(); string keys is the
  // same runtime behaviour z.record(z.unknown()) had under zod 3.
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/**
 * Text that carries a link. Mirrors LINK_PATTERN in the server's
 * @agentstrack/event-schema: project names end up in mail and alerts the
 * server sends, so the server drops a linked name at ingest — and the
 * collector drops it here first, so it never leaves the machine.
 */
export const LINK_PATTERN = /:\/\/|www\.|[a-z0-9-]\.[a-z]{2,}\//i;

/** Longest project name sent. Mirrors PROJECT_NAME_MAX on the server. */
export const PROJECT_NAME_MAX = 100;

/**
 * Mirrors the server's sanitizeProjectName: trimmed, cut to PROJECT_NAME_MAX,
 * undefined when blank or carrying a link (the server then names the project
 * after the git remote). Never a rejection — the session still uploads.
 */
export function sanitizeProjectName(value: string): string | undefined {
  const name = value.trim();
  if (!name || LINK_PATTERN.test(name)) return undefined;
  return name.slice(0, PROJECT_NAME_MAX).trim();
}

export interface RepoContext {
  remote_hash?: string;
  remote_owner?: string;
  remote_name?: string;
  branch?: string;
  project_path?: string;
  /** Always passed through sanitizeProjectName. */
  project_name?: string;
}
