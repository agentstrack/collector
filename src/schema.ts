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

export const AGENTS = ['claude_code', 'codex', 'gemini_cli', 'opencode', 'cursor', 'cline', 'copilot_cli', 'other'] as const;
export type AgentId = (typeof AGENTS)[number];

export const EVENT_TYPES = [
  'session.started', 'session.ended', 'user.prompted',
  'agent.turn.started', 'agent.turn.ended',
  'model.request', 'model.response',
  'tool.started', 'tool.completed', 'tool.failed',
  'file.read', 'file.changed', 'command.executed',
  'git.commit', 'git.branch_changed',
  'usage.reported', 'error', 'heartbeat',
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
  payload: z.record(z.unknown()).default({}),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export interface RepoContext {
  remote_hash?: string;
  remote_owner?: string;
  remote_name?: string;
  branch?: string;
  project_path?: string;
  project_name?: string;
}
