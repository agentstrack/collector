import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, DetectionResult, HealthStatus, NormalizeContext, NormalizedEvent } from './types.js';
import { newestJsonl, num, readHeadLines, safeJsonParse, str } from './types.js';
import { emptyUsage, type TokenUsage } from '../schema.js';
import { deriveTitle } from '../sessions/title.js';
import { redact } from '../privacy/redact.js';

/**
 * OpenAI Codex CLI adapter.
 *
 * Source: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *
 * Verified line shapes (Codex 0.120.x):
 *   {"type":"session_meta","payload":{"id":"…","cwd":"…","cli_version":"0.120.0",
 *    "model_provider":"openai"}}
 *   {"type":"turn_context","payload":{"turn_id":"…","model":"gpt-5.4","effort":"high"}}
 *   {"type":"event_msg","payload":{"type":"token_count","info":{
 *      "total_token_usage":{…},"last_token_usage":{…}},"rate_limits":{"plan_type":"plus"}}}
 *   {"type":"response_item","payload":{"type":"function_call","name":"exec_command",…}}
 *   {"type":"event_msg","payload":{"type":"exec_command_end","call_id":"…",
 *    "command":["/bin/zsh","-lc","…"],"exit_code":0,"duration":{"secs":1,"nanos":5e8},"status":"completed"}}
 *   {"type":"response_item","payload":{"type":"function_call_output","call_id":"…","output":"…"}}
 *
 * The important subtlety: token_count reports RUNNING TOTALS. These are emitted
 * as cumulative snapshots so the server treats them as a gauge, not a counter —
 * summing them would multiply a session's tokens by the number of snapshots.
 * Per-turn deltas from `last_token_usage` were checked against real rollouts
 * and do NOT reconcile to the final total (duplicate snapshots, resets), so the
 * gauge stays; the price is that a mid-session model switch reports the whole
 * total under both models (see docs/EVENT_SCHEMA.md).
 */
export const CODEX_DIR = process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
const SESSIONS_DIR = join(CODEX_DIR, 'sessions');

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';

  /** Session id and model carry across lines within one rollout file. */
  private readonly fileState = new Map<string, FileState>();

  async detect(): Promise<DetectionResult> {
    if (!existsSync(SESSIONS_DIR)) {
      return { installed: false, watchPaths: [], note: `No rollouts at ${SESSIONS_DIR}` };
    }
    // session_meta carries cli_version — report the real version rather than
    // leaving it null and making every Codex install look unidentifiable.
    return { installed: true, version: readCliVersion(), watchPaths: [SESSIONS_DIR] };
  }

  async health(): Promise<HealthStatus> {
    const detection = await this.detect();
    if (!detection.installed) return { healthy: false, filesTracked: 0, error: detection.note };
    let filesTracked = 0;
    try {
      // Rollouts nest as YYYY/MM/DD; count leaves without walking everything.
      const years = readdirSync(SESSIONS_DIR).filter((d) => /^\d{4}$/.test(d));
      for (const year of years.slice(-2)) {
        for (const month of readdirSync(join(SESSIONS_DIR, year))) {
          for (const day of readdirSync(join(SESSIONS_DIR, year, month))) {
            filesTracked += readdirSync(join(SESSIONS_DIR, year, month, day)).filter((f) =>
              f.endsWith('.jsonl'),
            ).length;
          }
        }
      }
    } catch (error) {
      return { healthy: false, filesTracked, error: error instanceof Error ? error.message : String(error) };
    }
    return { healthy: true, filesTracked };
  }

  normalize(line: string, ctx: NormalizeContext): NormalizedEvent[] {
    const raw = safeJsonParse(line);
    if (!raw) return [];

    const type = str(raw['type']);
    const payload = (raw['payload'] ?? {}) as Record<string, unknown>;
    const occurredAt = str(raw['timestamp']);
    if (!type || !occurredAt) return [];

    let state = this.fileState.get(ctx.sourceFile);
    if (!state) {
      // A daemon restart resumes mid-file, after session_meta was consumed.
      // The rollout is named rollout-<ts>-<uuid>.jsonl and that uuid IS the
      // session id (13/13 real files), so seed it from the name; model and
      // cwd come back with the next turn_context.
      state = { sessionId: /([0-9a-f-]{36})\.jsonl$/i.exec(ctx.sourceFile)?.[1], calls: new Map() };
      this.fileState.set(ctx.sourceFile, state);
    }

    if (type === 'session_meta') {
      state.sessionId = str(payload['id']) ?? state.sessionId;
      state.version = str(payload['cli_version']);
      state.cwd = str(payload['cwd']);
      if (!state.sessionId) return [];
      return [
        this.wrap(state, occurredAt, 'session.started', {
          external_session_id: state.sessionId,
          cwd: state.cwd,
          repo: state.cwd ? { project_path: state.cwd } : undefined,
        }),
      ];
    }

    if (type === 'turn_context') {
      state.model = str(payload['model']) ?? state.model;
      state.cwd ??= str(payload['cwd']);
      if (!state.sessionId || !state.model) return [];
      return [
        this.wrap(state, occurredAt, 'agent.turn.started', {
          turn_id: str(payload['turn_id']),
          model: state.model,
        }),
      ];
    }

    if (!state.sessionId) return []; // lines before session_meta have no session

    if (type === 'event_msg') return this.normalizeEventMsg(state, occurredAt, payload);
    if (type === 'response_item') return this.normalizeResponseItem(state, occurredAt, payload);
    return [];
  }

  private normalizeEventMsg(
    state: FileState,
    occurredAt: string,
    payload: Record<string, unknown>,
  ): NormalizedEvent[] {
    const kind = str(payload['type']);

    if (kind === 'token_count') {
      const info = (payload['info'] ?? {}) as Record<string, unknown>;
      const rateLimits = (payload['rate_limits'] ?? {}) as Record<string, unknown>;
      const planType = str(rateLimits['plan_type']);
      return [
        this.wrap(state, occurredAt, 'usage.reported', {
          model: state.model,
          provider: 'openai',
          usage: readCodexUsage(info['total_token_usage']),
          // Running totals: the server takes the max rather than summing.
          cumulative: true,
          plan_type: planType,
        }),
      ];
    }

    if (kind === 'user_message') {
      const message = str(payload['message']) ?? '';
      return [
        this.wrap(state, occurredAt, 'user.prompted', {
          prompt_chars: message.length,
          prompt_text: message,
          derived_title: deriveTitle(message),
        }),
      ];
    }

    if (kind === 'exec_command_end') {
      // The real shape: argv list, {secs,nanos} duration, numeric exit_code.
      // This is also where an exec_command call terminates — its
      // function_call_output is a bare string with no exit status.
      const callId = str(payload['call_id']);
      const exitCode = num(payload['exit_code']);
      const duration = (payload['duration'] ?? {}) as Record<string, unknown>;
      const durationMs = num(duration['secs']) * 1000 + Math.round(num(duration['nanos']) / 1e6);
      const failed = exitCode !== 0 || str(payload['status']) === 'failed';
      // The entry stays in `calls`: the function_call_output that must be
      // ignored below may still be on its way.
      const toolName = (callId && state.calls.get(callId)) ?? 'exec_command';
      return [
        this.wrap(state, occurredAt, failed ? 'tool.failed' : 'tool.completed', {
          tool_name: toolName,
          tool_call_id: callId,
          duration_ms: durationMs,
        }),
        this.wrap(state, occurredAt, 'command.executed', {
          command: joinCommand(payload['command']) ?? str(payload['command']) ?? 'shell',
          exit_code: exitCode,
          duration_ms: durationMs,
        }),
      ];
    }

    if (kind === 'task_complete') {
      return [this.wrap(state, occurredAt, 'agent.turn.ended', { turn_id: str(payload['turn_id']) })];
    }

    if (kind === 'error' || kind === 'stream_error') {
      const message = str(payload['message']);
      return [
        this.wrap(state, occurredAt, 'error', {
          error_kind: kind,
          // Redacted before the truncation, for the same reason deriveTitle is:
          // a cut through a secret leaves two halves that match no pattern, so
          // the privacy pipeline's later pass over `message` ships the fragment.
          message: message === undefined ? undefined : redact(message).text.slice(0, 1000),
        }),
      ];
    }

    return [];
  }

  private normalizeResponseItem(
    state: FileState,
    occurredAt: string,
    payload: Record<string, unknown>,
  ): NormalizedEvent[] {
    const kind = str(payload['type']);

    // Recent Codex builds report the same tool calls as `custom_tool_call`
    // (apply_patch and the JS `exec` tool both arrive that way).
    if (kind === 'function_call' || kind === 'custom_tool_call') {
      const toolName = str(payload['name']) ?? 'unknown';
      const callId = str(payload['call_id']);
      if (callId) state.calls.set(callId, toolName);
      const events = [
        this.wrap(state, occurredAt, 'tool.started', {
          tool_name: toolName,
          tool_call_id: callId,
        }),
      ];
      for (const file of fileTouches(payload)) {
        const { event_type, ...rest } = file;
        events.push(this.wrap(state, occurredAt, event_type, rest));
      }
      return events;
    }

    if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
      const callId = str(payload['call_id']);
      const toolName = (callId && state.calls.get(callId)) ?? str(payload['name']) ?? 'unknown';
      // exec_command terminates on its exec_command_end (which carries the exit
      // status); the two arrive in either order, so key on the tool, not on order.
      if (toolName === 'exec_command') return [];
      if (callId) state.calls.delete(callId);
      // `output` is a string (or a content list for custom tools), never an
      // object. Only the shell_command tool prefixes it with the exit status.
      const exitHeader = /^Exit code: (\d+)/.exec(str(payload['output']) ?? '');
      const failed = exitHeader !== null && exitHeader[1] !== '0';
      return [
        this.wrap(state, occurredAt, failed ? 'tool.failed' : 'tool.completed', {
          tool_name: toolName,
          tool_call_id: callId,
        }),
      ];
    }

    if (kind === 'web_search_call') {
      return [this.wrap(state, occurredAt, 'tool.completed', { tool_name: 'web_search' })];
    }

    return [];
  }

  private wrap(
    state: FileState,
    occurredAt: string,
    event_type: NormalizedEvent['event']['event_type'],
    payload: Record<string, unknown>,
  ): NormalizedEvent {
    return {
      event: {
        occurred_at: occurredAt,
        session_id: state.sessionId!,
        agent: 'codex',
        agent_version: state.version,
        event_type,
        payload,
      },
      cwd: state.cwd,
      repo: state.cwd ? { project_path: state.cwd } : undefined,
    };
  }
}

interface FileState {
  sessionId?: string;
  model?: string;
  version?: string;
  cwd?: string;
  /** call_id → tool name; `*_output` lines carry no name of their own. */
  calls: Map<string, string>;
}

/** Newest rollout's `session_meta.cli_version`, if one can be found cheaply. */
function readCliVersion(): string | undefined {
  try {
    const years = readdirSync(SESSIONS_DIR).filter((d) => /^\d{4}$/.test(d)).sort().reverse();
    for (const year of years.slice(0, 2)) {
      for (const month of readdirSync(join(SESSIONS_DIR, year)).sort().reverse()) {
        for (const day of readdirSync(join(SESSIONS_DIR, year, month)).sort().reverse()) {
          const file = newestJsonl(join(SESSIONS_DIR, year, month, day));
          if (!file) continue;
          // session_meta is the first line of a rollout, so the head suffices.
          for (const line of readHeadLines(file)) {
            const parsed = safeJsonParse(line);
            if (!parsed || str(parsed['type']) !== 'session_meta') continue;
            const version = str((parsed['payload'] as Record<string, unknown> | undefined)?.['cli_version']);
            if (version) return version;
          }
        }
      }
    }
  } catch {
    // Unreadable rollout tree: absent is better than fabricated.
  }
  return undefined;
}

/**
 * Codex usage shape. reasoning_output_tokens is a SUBSET of output_tokens and
 * must not be added on top. Likewise cached_input_tokens is a SUBSET of
 * input_tokens (codex-rs: non_cached_input = input - cached), while the
 * normalized shape keeps them exclusive the way Claude Code reports them —
 * copying both verbatim billed every cached token twice.
 */
export function readCodexUsage(raw: unknown): TokenUsage {
  const usage = (raw ?? {}) as Record<string, unknown>;
  const cached = num(usage['cached_input_tokens']);
  return {
    ...emptyUsage(),
    input_tokens: Math.max(0, num(usage['input_tokens']) - cached),
    cached_input_tokens: cached,
    output_tokens: num(usage['output_tokens']),
    reasoning_output_tokens: num(usage['reasoning_output_tokens']),
  };
}

interface FileTouch {
  event_type: 'file.changed' | 'file.read';
  path: string;
  change_kind?: 'create' | 'edit' | 'delete' | 'rename';
  lines_added?: number;
  lines_removed?: number;
}

/**
 * File activity recovered from a tool call.
 *
 * Codex has no dedicated file event: everything is apply_patch or a shell
 * command, so the patch body is the only place exact line counts exist.
 */
export function fileTouches(payload: Record<string, unknown>): FileTouch[] {
  const { patch, command } = toolInput(payload);
  if (patch) {
    return parseApplyPatch(patch).map((f) => ({ event_type: 'file.changed' as const, ...f }));
  }
  return command ? shellFileTouches(command) : [];
}

/**
 * The call input, whichever way this Codex build encoded it: `arguments` as a
 * JSON string (function_call) or `input` as raw text (custom_tool_call).
 */
function toolInput(payload: Record<string, unknown>): { patch?: string; command?: string } {
  const raw = str(payload['input']) ?? str(payload['arguments']);
  if (!raw) return {};

  const parsed = raw.trimStart().startsWith('{') ? safeJsonParse(raw) : null;
  if (parsed) {
    const command = str(parsed['cmd']) ?? str(parsed['command']) ?? joinCommand(parsed['command']);
    return { patch: str(parsed['input']) ?? str(parsed['patch']), command };
  }
  if (raw.includes('*** Begin Patch')) return { patch: raw };
  // Anything else is the JS body of the `exec` tool. Digging a command out of
  // arbitrary JavaScript would invent file events, so it is left alone.
  return {};
}

/** Older Codex builds send shell argv as an array: ["bash","-lc","…"]. */
function joinCommand(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter((v): v is string => typeof v === 'string');
  return parts.length > 0 ? parts[parts.length - 1] : undefined;
}

export interface PatchFile {
  path: string;
  change_kind: 'create' | 'edit' | 'delete' | 'rename';
  lines_added: number;
  lines_removed: number;
}

/** Parses the apply_patch envelope Codex writes files with. */
export function parseApplyPatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;

  for (const line of patch.split('\n')) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      current = {
        path: header[2]!.trim(),
        change_kind: header[1] === 'Add' ? 'create' : header[1] === 'Delete' ? 'delete' : 'edit',
        lines_added: 0,
        lines_removed: 0,
      };
      files.push(current);
      continue;
    }
    if (line.startsWith('*** ')) {
      if (current && line.startsWith('*** Move to:')) current.change_kind = 'rename';
      if (line.startsWith('*** End Patch')) current = null;
      continue;
    }
    if (!current) continue;
    // Hunk headers start with @@; context lines start with a space.
    if (line.startsWith('+')) current.lines_added += 1;
    else if (line.startsWith('-')) current.lines_removed += 1;
  }
  return files;
}

const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'sed', 'nl', 'bat', 'less']);

/**
 * Files a shell command touched.
 *
 * ponytail: deliberately a narrow heuristic — a redirect target is a write, a
 * pager/cat argument is a read, and nothing else is guessed at. Widening it
 * would manufacture file events out of ordinary shell noise. Upgrade path is
 * a real shell parser if the numbers ever need to be exact.
 */
export function shellFileTouches(command: string): FileTouch[] {
  const touches: FileTouch[] = [];

  for (const match of command.matchAll(/(?:^|\s)>>?\s*("[^"]+"|'[^']+'|[^\s;|&<>]+)/g)) {
    const path = unquote(match[1]!);
    if (isPath(path)) touches.push({ event_type: 'file.changed', path, change_kind: 'edit' });
  }

  for (const segment of command.split(/[;|&\n]+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const head = tokens[0];
    if (!head || !READ_COMMANDS.has(head)) continue;
    const last = unquote(tokens[tokens.length - 1]!);
    if (isPath(last)) touches.push({ event_type: 'file.read', path: last });
  }

  // One tool call cannot plausibly touch dozens of files; cap the blast radius.
  return touches.slice(0, 20);
}

function unquote(token: string): string {
  return token.replace(/^["']|["']$/g, '');
}

function isPath(token: string): boolean {
  if (token.startsWith('-') || token.startsWith('/dev/')) return false;
  return /[./]/.test(token) && !/^\d+$/.test(token);
}
