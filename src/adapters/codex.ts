import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AccountIdentity, AgentAdapter, DetectionResult, HealthStatus, NormalizeContext, NormalizedEvent,
} from './types.js';
import { readCodexAccount } from './account.js';
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
 *
 * Codex ≥0.15x changed shape. Prompts, commands and edits arrive as
 * {"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage"|
 * "CommandExecution"|"FileChange"|"McpToolCall",…}}}; user_message and
 * exec_command_end are gone. Each model response also writes a top-level
 * {"type":"token_usage_record","payload":{"response_id","usage",…}} that sums
 * exactly to the thread total, so those files are billed per response and the
 * gauge is not emitted for them (normalizeTokenUsageRecord).
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

  /** The ChatGPT login in auth.json; undefined for API-key logins. See readCodexAccount. */
  account(): AccountIdentity | undefined {
    return readCodexAccount(CODEX_DIR);
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
      // A forked or multi-agent v2 thread is rollout-<ts>-<parent>_<child>.jsonl;
      // the trailing uuid is the child, which is this file's session.
      state = {
        sessionId: /([0-9a-f-]{36})\.jsonl$/i.exec(ctx.sourceFile)?.[1],
        calls: new Map(),
        seenResponseIds: new Set(),
        // Resuming mid-file can land past the first item or usage record, so the
        // format is read from the whole file once rather than inferred from order.
        ...rolloutFormat(ctx.sourceFile),
      };
      this.fileState.set(ctx.sourceFile, state);
    }

    if (type === 'session_meta') {
      state.sessionId = str(payload['id']) ?? state.sessionId;
      state.version = str(payload['cli_version']);
      state.cwd = str(payload['cwd']);
      if (!state.sessionId) return [];
      // A fork or multi-agent v2 child starts from another thread's history.
      const historyBase = (payload['history_base'] ?? {}) as Record<string, unknown>;
      return [
        this.wrap(state, occurredAt, 'session.started', {
          external_session_id: state.sessionId,
          parent_session_id: str(historyBase['thread_id']),
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

    if (type === 'token_usage_record') return this.normalizeTokenUsageRecord(state, occurredAt, payload);
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

    if (kind === 'token_count') return this.tokenCountUsage(state, occurredAt, payload);

    if (kind === 'item_completed') return this.normalizeItemCompleted(state, occurredAt, payload);

    if (kind === 'user_message') {
      // One prompt source per file: a build that wrote both must not count twice.
      if (state.itemMode) return [];
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
      const durationMs = secsNanosMs(payload['duration']);
      const failed = exitCode !== 0 || str(payload['status']) === 'failed';
      // The entry stays in `calls`: the function_call_output that must be
      // ignored below may still be on its way.
      const toolName = (callId && state.calls.get(callId)) ?? 'exec_command';
      const terminal = this.wrap(state, occurredAt, failed ? 'tool.failed' : 'tool.completed', {
        tool_name: toolName,
        tool_call_id: callId,
        duration_ms: durationMs,
      });
      // In item mode the CommandExecution item reports the command; once is enough.
      if (state.itemMode) return [terminal];
      return [
        terminal,
        this.wrap(state, occurredAt, 'command.executed', {
          command: joinCommand(payload['command']) ?? str(payload['command']) ?? 'shell',
          exit_code: exitCode,
          duration_ms: durationMs,
        }),
      ];
    }

    if (kind === 'task_complete') {
      return [
        this.wrap(state, occurredAt, 'agent.turn.ended', {
          turn_id: str(payload['turn_id']),
          duration_ms: nonNegativeInt(payload['duration_ms']),
        }),
      ];
    }

    if (kind === 'turn_aborted') {
      return [
        this.wrap(state, occurredAt, 'agent.turn.ended', {
          turn_id: str(payload['turn_id']),
          duration_ms: nonNegativeInt(payload['duration_ms']),
          aborted: true,
          // Codex's own enum ("interrupted", "replaced", …), not user text.
          abort_reason: str(payload['reason'])?.slice(0, 50),
        }),
      ];
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

  /** The usage half of a `token_count` line: the session's running total as a gauge. */
  private tokenCountUsage(
    state: FileState,
    occurredAt: string,
    payload: Record<string, unknown>,
  ): NormalizedEvent[] {
    const info = (payload['info'] ?? {}) as Record<string, unknown>;
    const rateLimits = (payload['rate_limits'] ?? {}) as Record<string, unknown>;
    const planType = str(rateLimits['plan_type']);
    state.planType = planType ?? state.planType;
    // A file with per-response token_usage_record lines is billed from those;
    // the running total here would add a second, overlapping figure.
    if (state.usageFromRecords) return [];
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

  /**
   * One model response's tokens (Codex ≥0.15x). Summed, not gauged: per
   * response they reconcile exactly to the thread total, are tagged with the
   * model that actually served them, and exclude the parent history a fork or
   * multi-agent child inherits (its `thread_token_usage` starts at the
   * parent's total, which the gauge billed a second time).
   */
  private normalizeTokenUsageRecord(
    state: FileState,
    occurredAt: string,
    payload: Record<string, unknown>,
  ): NormalizedEvent[] {
    state.usageFromRecords = true;
    const responseId = str(payload['response_id']);
    if (responseId) {
      if (state.seenResponseIds.has(responseId)) return [];
      state.seenResponseIds.add(responseId);
    }
    return [
      this.wrap(state, occurredAt, 'usage.reported', {
        model: state.model,
        provider: 'openai',
        usage: readCodexUsage(payload['usage']),
        cumulative: false,
        plan_type: state.planType,
      }),
    ];
  }

  /**
   * `event_msg/item_completed` (Codex ≥0.15x), which replaced `user_message`
   * and `exec_command_end`. Tool start/finish still comes from the
   * response_item calls, so only what those lines lack is taken from here.
   */
  private normalizeItemCompleted(
    state: FileState,
    occurredAt: string,
    payload: Record<string, unknown>,
  ): NormalizedEvent[] {
    state.itemMode = true;
    const item = (payload['item'] ?? {}) as Record<string, unknown>;
    const kind = str(item['type']);

    if (kind === 'UserMessage') {
      const content = Array.isArray(item['content']) ? (item['content'] as Record<string, unknown>[]) : [];
      const message = content
        .filter((c) => str(c?.['type']) === 'text')
        .map((c) => str(c['text']) ?? '')
        .join('\n');
      return [
        this.wrap(state, occurredAt, 'user.prompted', {
          prompt_chars: message.length,
          prompt_text: message,
          derived_title: deriveTitle(message),
        }),
      ];
    }

    if (kind === 'CommandExecution') {
      const command = joinCommand(item['command']) ?? str(item['command']);
      if (!command) return [];
      const events = [
        this.wrap(state, occurredAt, 'command.executed', {
          command,
          exit_code: num(item['exit_code']),
          duration_ms: secsNanosMs(item['duration']),
        }),
      ];
      for (const { event_type, ...rest } of shellFileTouches(command)) {
        events.push(this.wrap(state, occurredAt, event_type, rest));
      }
      return events;
    }

    if (kind === 'FileChange') {
      const status = str(item['status']);
      if (status === 'failed' || status === 'declined') return [];
      return fileChangeTouches(item['changes']).map(({ event_type, ...rest }) =>
        this.wrap(state, occurredAt, event_type, rest),
      );
    }

    if (kind === 'McpToolCall') {
      // MCP calls have no response_item line, so this is their only trace.
      // One terminal event, as OpenCode does; the server backfills the start.
      const server = str(item['server']) ?? 'unknown';
      const tool = str(item['tool']) ?? 'unknown';
      const result = (item['result'] ?? {}) as Record<string, unknown>;
      const failed = result['isError'] === true || str(item['status']) === 'failed';
      const started = num(payload['started_at_ms']);
      const completed = num(payload['completed_at_ms']);
      return [
        this.wrap(state, occurredAt, failed ? 'tool.failed' : 'tool.completed', {
          tool_name: `mcp__${server}__${tool}`,
          tool_call_id: str(item['id']),
          duration_ms: started > 0 && completed >= started ? completed - started : undefined,
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
      // In item mode FileChange and CommandExecution items carry the file effects;
      // deriving them from the call as well would count every edit twice.
      for (const file of state.itemMode ? [] : fileTouches(payload)) {
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
  /** The file has token_usage_record lines: bill per response, not the gauge. */
  usageFromRecords?: boolean;
  /** The file has item_completed lines: prompts, commands and edits come from items. */
  itemMode?: boolean;
  seenResponseIds: Set<string>;
  /** Last plan seen on a token_count; records carry none of their own. */
  planType?: string;
}

const RECORD_MARKER = Buffer.from('"type":"token_usage_record"');
const ITEM_MARKER = Buffer.from('"type":"item_completed"');

/**
 * Which rollout format a file is in, read once when the adapter first sees it.
 * ponytail: a byte scan of the whole file per file per daemon start; rollouts
 * are MBs, so a streaming scan is the upgrade if they ever reach GBs.
 */
export function rolloutFormat(path: string): { usageFromRecords: boolean; itemMode: boolean } {
  try {
    const data = readFileSync(path);
    return { usageFromRecords: data.includes(RECORD_MARKER), itemMode: data.includes(ITEM_MARKER) };
  } catch {
    return { usageFromRecords: false, itemMode: false };
  }
}

/** Codex's `{secs, nanos}` duration in milliseconds. */
function secsNanosMs(value: unknown): number {
  const duration = (value ?? {}) as Record<string, unknown>;
  return num(duration['secs']) * 1000 + Math.round(num(duration['nanos']) / 1e6);
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
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

/**
 * File effects of a FileChange item: `changes` maps an absolute path to
 * `{type, content}` (add) or `{type, unified_diff}` (update). Line counts are
 * computed here because nothing downstream knows these keys — the bodies are
 * never copied into an event.
 */
export function fileChangeTouches(changes: unknown): FileTouch[] {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return [];
  const touches: FileTouch[] = [];
  for (const [path, raw] of Object.entries(changes as Record<string, unknown>)) {
    const change = (raw ?? {}) as Record<string, unknown>;
    const type = str(change['type']);
    const content = str(change['content']);
    const diff = str(change['unified_diff']) ?? str(change['diff']);
    const lines = content === undefined || content === '' ? 0 : content.replace(/\n$/, '').split('\n').length;
    if (type === 'add') {
      touches.push({ event_type: 'file.changed', path, change_kind: 'create', lines_added: lines, lines_removed: 0 });
    } else if (type === 'delete') {
      touches.push({ event_type: 'file.changed', path, change_kind: 'delete', lines_added: 0, lines_removed: lines });
    } else {
      const counts = diff === undefined ? {} : countUnifiedDiff(diff);
      const moved = str(change['move_path']);
      touches.push({ event_type: 'file.changed', path, change_kind: moved ? 'rename' : 'edit', ...counts });
    }
  }
  return touches;
}

function countUnifiedDiff(diff: string): { lines_added: number; lines_removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { lines_added: added, lines_removed: removed };
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
