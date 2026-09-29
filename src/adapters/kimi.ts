import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { AgentAdapter, DetectionResult, HealthStatus, NormalizeContext, NormalizedEvent } from './types.js';
import { num, safeJsonParse, str } from './types.js';
import { countEditLines } from './claude.js';
import { emptyUsage } from '../schema.js';
import { deriveTitle } from '../sessions/title.js';
import { deterministicEventId } from '../queue/event-id.js';

/**
 * Kimi Code CLI (MoonshotAI `kimi-cli`) adapter.
 *
 * FORMAT FROM UPSTREAM SOURCE, NOT YET VERIFIED AGAINST REAL SESSIONS: kimi-cli
 * was not installed where this was written. Read from kimi-cli 1.52.0 (PyPI
 * wheel) and kosong 0.56.0 — share.py, metadata.py, session.py, wire/file.py,
 * wire/types.py, soul/kimisoul.py.
 *
 *   $KIMI_SHARE_DIR (default ~/.kimi)/
 *     kimi.json                 {work_dirs: [{path, kaos, last_session_id}]}
 *     config.toml               default_model + [models.<name>] model = "…"
 *     sessions/<md5(work dir path)>/<session uuid>/
 *       wire.jsonl              the event log read here
 *       context.jsonl           the model's message history (content: ignored)
 *       subagents/<id>/wire.jsonl  duplicates of what the parent receives as
 *                               SubagentEvent: ignored to avoid double counts
 *
 * wire.jsonl: first line `{"type":"metadata","protocol_version":"1.10"}`, then
 * `{"timestamp": <epoch seconds>, "message": {"type": <class name>, "payload": {…}}}`:
 *   TurnBegin {user_input: str | [{type:"text", text}]}, TurnEnd {},
 *   StatusUpdate {token_usage?: {input_other, output, input_cache_read,
 *     input_cache_creation}, message_id?}  — PER STEP, not cumulative,
 *   ToolCall {id, function: {name, arguments: <json string>}},
 *   ToolResult {tool_call_id, return_value: {is_error, …}},
 *   SubagentEvent {agent_id, event: {type, payload}}.
 *
 * The wire log never names the model. The model a session used is taken from
 * config.toml's default_model — a point-in-time reading, so a session run
 * under a `/model` switch is attributed to the default.
 */
const KIMI_HOME = process.env['KIMI_SHARE_DIR'] ?? join(homedir(), '.kimi');

export class KimiCodeAdapter implements AgentAdapter {
  readonly id = 'kimi_code';

  /** tool call id → name and start time, for the result that follows. */
  private readonly calls = new Map<string, { name: string; atMs: number }>();

  constructor(private readonly home: string = KIMI_HOME) {}

  async detect(): Promise<DetectionResult> {
    const sessions = join(this.home, 'sessions');
    if (!existsSync(sessions)) return { installed: false, watchPaths: [], note: `No Kimi sessions at ${sessions}` };
    return { installed: true, watchPaths: [sessions] };
  }

  async health(): Promise<HealthStatus> {
    const detection = await this.detect();
    return detection.installed
      ? { healthy: true, filesTracked: 0 }
      : { healthy: false, filesTracked: 0, error: detection.note };
  }

  normalize(line: string, ctx: NormalizeContext): NormalizedEvent[] {
    // Only a session's own wire.jsonl: sessions/<hash>/<session>/wire.jsonl.
    const file = ctx.sourceFile;
    if (basename(file) !== 'wire.jsonl' || basename(dirname(dirname(dirname(file)))) !== 'sessions') return [];
    const raw = safeJsonParse(line);
    const timestamp = num(raw?.['timestamp']);
    const message = raw?.['message'];
    if (!timestamp || !message || typeof message !== 'object') return [];

    const sessionId = basename(dirname(file));
    const cwd = workDirOf(this.home, basename(dirname(dirname(file))));
    return this.messageEvents(
      { sessionId, cwd, model: defaultModel(this.home) },
      Math.round(timestamp * 1000),
      message as Record<string, unknown>,
    );
  }

  private messageEvents(s: Session, atMs: number, message: Record<string, unknown>): NormalizedEvent[] {
    const type = str(message['type']);
    const p = (message['payload'] ?? {}) as Record<string, unknown>;
    const at = new Date(atMs).toISOString();
    const wrap = (t: NormalizedEvent['event']['event_type'], payload: Record<string, unknown>, eventId?: string) =>
      event(s, at, t, payload, eventId);

    switch (type) {
      case 'TurnBegin': {
        const prompt = inputText(p['user_input']);
        return [
          // Keyed on the session: every turn "starts" it, the spool keeps the first.
          wrap('session.started', { external_session_id: s.sessionId, cwd: s.cwd, model: s.model }, id(s, 'session')),
          wrap('agent.turn.started', { model: s.model }),
          ...(prompt
            ? [wrap('user.prompted', { prompt_chars: prompt.length, prompt_text: prompt, derived_title: deriveTitle(prompt) })]
            : []),
        ];
      }
      case 'TurnEnd':
        return [wrap('agent.turn.ended', {})];
      case 'StatusUpdate': {
        const u = p['token_usage'];
        if (!u || typeof u !== 'object' || !s.model) return [];
        const usage = u as Record<string, unknown>;
        return [
          wrap('model.response', {
            model: s.model,
            usage: {
              ...emptyUsage(),
              input_tokens: num(usage['input_other']),
              cached_input_tokens: num(usage['input_cache_read']),
              cache_creation_input_tokens: num(usage['input_cache_creation']),
              output_tokens: num(usage['output']),
            },
          }),
        ];
      }
      case 'ToolCall': {
        const fn = (p['function'] ?? {}) as Record<string, unknown>;
        const name = str(fn['name']);
        const callId = str(p['id']);
        if (!name) return [];
        if (callId) this.calls.set(callId, { name, atMs });
        return [wrap('tool.started', { tool_name: name, tool_call_id: callId }), ...toolTouches(name, fn['arguments'], wrap)];
      }
      case 'ToolResult': {
        const callId = str(p['tool_call_id']);
        const call = callId ? this.calls.get(callId) : undefined;
        if (callId) this.calls.delete(callId);
        const value = (p['return_value'] ?? {}) as Record<string, unknown>;
        return [
          wrap(value['is_error'] === true ? 'tool.failed' : 'tool.completed', {
            tool_name: call?.name ?? 'unknown',
            tool_call_id: callId,
            ...(call ? { duration_ms: Math.max(0, atMs - call.atMs) } : {}),
          }),
        ];
      }
      case 'SubagentEvent': {
        // A subagent's work is the parent session's cost; unwrap one level.
        const inner = p['event'];
        return inner && typeof inner === 'object' && str((inner as Record<string, unknown>)['type']) !== 'TurnBegin'
          ? this.messageEvents(s, atMs, inner as Record<string, unknown>).map((e) => ({
              ...e,
              event: { ...e.event, payload: { ...e.event.payload, sidechain: true, agent_id: str(p['agent_id']) } },
            }))
          : [];
      }
      default:
        return [];
    }
  }
}

interface Session {
  sessionId: string;
  cwd?: string;
  model?: string;
}

type Wrap = (t: NormalizedEvent['event']['event_type'], payload: Record<string, unknown>) => NormalizedEvent;

/** File and command side effects of the built-in tools (Shell, ReadFile, WriteFile, StrReplaceFile). */
function toolTouches(name: string, rawArgs: unknown, wrap: Wrap): NormalizedEvent[] {
  const args = safeJsonParse(str(rawArgs) ?? '') ?? {};
  const path = str(args['path']);
  const command = str(args['command']);
  if (name === 'Shell' && command) return [wrap('command.executed', { command })];
  if (!path) return [];
  if (name === 'ReadFile') return [wrap('file.read', { path })];
  if (name === 'WriteFile') {
    return [wrap('file.changed', { path, change_kind: 'create', ...countEditLines('Write', { content: args['content'] }) })];
  }
  if (name === 'StrReplaceFile') {
    const edits = Array.isArray(args['edit']) ? args['edit'] : [args['edit']];
    let lines_added = 0;
    let lines_removed = 0;
    for (const e of edits) {
      if (!e || typeof e !== 'object') continue;
      const r = e as Record<string, unknown>;
      const c = countEditLines('Edit', { old_string: r['old'], new_string: r['new'] });
      lines_added += c.lines_added;
      lines_removed += c.lines_removed;
    }
    return [wrap('file.changed', { path, change_kind: 'edit', lines_added, lines_removed })];
  }
  return [];
}

function inputText(input: unknown): string | undefined {
  if (typeof input === 'string') return input || undefined;
  if (!Array.isArray(input)) return undefined;
  const text = input
    .map((p) => (p && typeof p === 'object' && (p as Record<string, unknown>)['type'] === 'text' ? str((p as Record<string, unknown>)['text']) ?? '' : ''))
    .join('');
  return text || undefined;
}

function id(s: Session, key: string): string {
  return deterministicEventId(`kimi_code\n${s.sessionId}\n${key}`);
}

function event(
  s: Session,
  at: string,
  event_type: NormalizedEvent['event']['event_type'],
  payload: Record<string, unknown>,
  eventId?: string,
): NormalizedEvent {
  return {
    event: { occurred_at: at, session_id: s.sessionId, agent: 'kimi_code', event_type, payload },
    cwd: s.cwd,
    repo: s.cwd ? { project_path: s.cwd } : undefined,
    ...(eventId ? { eventId } : {}),
  };
}

/** Parsed file cached on mtime: normalize() runs per line. */
const fileCache = new Map<string, { mtimeMs: number; value: unknown }>();
function cached<T>(path: string, parse: (raw: string) => T): T | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = fileCache.get(path);
  if (hit?.mtimeMs === mtimeMs) return hit.value as T;
  let value: T | undefined;
  try {
    value = parse(readFileSync(path, 'utf8'));
  } catch {
    value = undefined;
  }
  fileCache.set(path, { mtimeMs, value });
  return value;
}

/** The work dir whose md5 names this sessions/ subfolder, from kimi.json. */
function workDirOf(home: string, hash: string): string | undefined {
  const dirs = cached(join(home, 'kimi.json'), (raw) => {
    const parsed = safeJsonParse(raw);
    const list = Array.isArray(parsed?.['work_dirs']) ? (parsed['work_dirs'] as unknown[]) : [];
    const map = new Map<string, string>();
    for (const w of list) {
      const path = w && typeof w === 'object' ? str((w as Record<string, unknown>)['path']) : undefined;
      const kaos = w && typeof w === 'object' ? str((w as Record<string, unknown>)['kaos']) : undefined;
      if (!path) continue;
      const md5 = createHash('md5').update(path).digest('hex');
      // Non-local KAOS (remote) dirs are prefixed `<kaos>_`; the path is not on this machine.
      map.set(kaos && kaos !== 'local' ? `${kaos}_${md5}` : md5, path);
    }
    return map;
  });
  return dirs?.get(hash);
}

/**
 * `default_model` resolved through `[models.<name>] model = "…"` in config.toml.
 *
 * ponytail: two regexes, not a TOML parser — only these two keys are read, and
 * the providers' `api_key` lines are never matched. Swap for a parser if the
 * config grows inline tables here.
 */
export function defaultModel(home: string): string | undefined {
  return cached(join(home, 'config.toml'), (raw) => {
    const name = /^default_model\s*=\s*"([^"]+)"/m.exec(raw)?.[1];
    if (!name) return undefined;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const section = new RegExp(`^\\[models\\.(?:"${escaped}"|${escaped})\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(raw)?.[1];
    return (section && /^model\s*=\s*"([^"]+)"/m.exec(section)?.[1]) ?? name;
  });
}
