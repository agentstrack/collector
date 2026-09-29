import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import type {
  AccountIdentity,
  AgentAdapter,
  DetectionResult,
  HealthStatus,
  NormalizeContext,
  NormalizedEvent,
} from './types.js';
import { num, readHeadLines, safeJsonParse, str } from './types.js';
import { readGeminiAccount } from './account.js';
import { countEditLines } from './claude.js';
import { emptyUsage, type TokenUsage } from '../schema.js';
import { deriveTitle } from '../sessions/title.js';
import { deterministicEventId } from '../queue/event-id.js';

/**
 * Gemini CLI adapter.
 *
 * Source: `<gemini home>/tmp/<project>/chats/session-<yyyy-mm-ddThh-mm>-<id8>.jsonl`
 * (subagents: `chats/<parent session id>/<session id>.jsonl`), where <gemini
 * home> is `$GEMINI_CLI_HOME/.gemini`, default `~/.gemini`, and
 * `tmp/<project>/.project_root` holds the project's absolute path. Checked
 * against the ChatRecordingService in the installed 0.61.0 bundle and the
 * files it wrote on this machine.
 *
 * Record shapes, one JSON object per line:
 *   {sessionId, projectHash, startTime, lastUpdated, kind: "main"|"subagent"}
 *   {id, timestamp, type: "user"|"gemini"|"info"|…, content, model?,
 *    tokens?: {input, output, cached, thoughts, tool, total}, toolCalls?: [
 *      {id, name, args, status: "success"|"error"|"cancelled", timestamp, result}]}
 *   {"$set": {lastUpdated?, messages?: [<message>…], summary?, …}}
 *   {"$rewindTo": <message id>}
 *
 * A message is RE-APPENDED under the same id whenever it changes — tokens
 * attached after the fact, tool calls merged in — and `$set.messages`
 * rewrites the whole list. Every event is therefore keyed on the message or
 * tool-call id, so the spool and the server absorb the repeats. A rewind
 * removes messages from the resumable history but the tokens were still
 * spent, so it is ignored.
 *
 * Older releases wrote a single `session-*.json` document instead; those are
 * not read (0.61 migrates them on resume).
 */
const GEMINI_HOME = join(process.env['GEMINI_CLI_HOME'] ?? homedir(), '.gemini');

export class GeminiCliAdapter implements AgentAdapter {
  readonly id = 'gemini_cli';

  /** Session id per chat file: a restart resumes mid-file, past the metadata line. */
  private readonly sessions = new Map<string, string | undefined>();

  constructor(private readonly home: string = GEMINI_HOME) {}

  async detect(): Promise<DetectionResult> {
    const tmp = join(this.home, 'tmp');
    if (!existsSync(tmp)) return { installed: false, watchPaths: [], note: `No Gemini CLI data at ${tmp}` };
    return { installed: true, watchPaths: [tmp] };
  }

  async health(): Promise<HealthStatus> {
    const detection = await this.detect();
    return detection.installed
      ? { healthy: true, filesTracked: 0 }
      : { healthy: false, filesTracked: 0, error: detection.note };
  }

  account(): AccountIdentity | undefined {
    return readGeminiAccount(this.home);
  }

  normalize(line: string, ctx: NormalizeContext): NormalizedEvent[] {
    // tmp/ also holds tool output and checkpoints; only chat logs are sessions.
    if (!ctx.sourceFile.split(sep).includes('chats')) return [];
    const raw = safeJsonParse(line);
    if (!raw) return [];

    const project = projectOf(ctx.sourceFile);
    if (str(raw['sessionId']) && str(raw['projectHash'])) {
      const sessionId = str(raw['sessionId'])!;
      this.sessions.set(ctx.sourceFile, sessionId);
      const startedAt = str(raw['startTime']);
      if (!startedAt) return [];
      const parent = str(raw['kind']) === 'subagent' ? basename(dirname(ctx.sourceFile)) : undefined;
      return [
        wrap(sessionId, project, startedAt, 'session.started', `session\n${sessionId}`, {
          external_session_id: sessionId,
          cwd: project,
          ...(parent ? { parent_session_id: parent } : {}),
        }),
      ];
    }

    const sessionId = this.sessionOf(ctx.sourceFile);
    if (!sessionId) return [];

    const set = raw['$set'];
    if (set && typeof set === 'object') {
      const messages = (set as Record<string, unknown>)['messages'];
      if (!Array.isArray(messages)) return [];
      return messages.flatMap((m) =>
        m && typeof m === 'object' ? messageEvents(sessionId, project, m as Record<string, unknown>) : [],
      );
    }
    return str(raw['id']) ? messageEvents(sessionId, project, raw) : [];
  }

  private sessionOf(file: string): string | undefined {
    if (!this.sessions.has(file)) {
      // The metadata line is always the first line of the file.
      const head = safeJsonParse(readHeadLines(file, 4096)[0] ?? '');
      this.sessions.set(file, str(head?.['sessionId']));
    }
    return this.sessions.get(file);
  }
}

function messageEvents(sessionId: string, project: string | undefined, m: Record<string, unknown>): NormalizedEvent[] {
  const id = str(m['id']);
  const at = str(m['timestamp']);
  if (!id || !at) return [];
  const type = str(m['type']);
  const events: NormalizedEvent[] = [];
  const emit = (t: NormalizedEvent['event']['event_type'], key: string, payload: Record<string, unknown>, when = at) =>
    events.push(wrap(sessionId, project, when, t, key, payload));

  if (type === 'user') {
    const prompt = contentText(m['content']);
    if (prompt && !isIgnoredUserContent(prompt.trim())) {
      emit('user.prompted', `prompt\n${id}`, {
        prompt_chars: prompt.length,
        prompt_text: prompt,
        derived_title: deriveTitle(prompt),
      });
    }
    return events;
  }
  if (type !== 'gemini') return events;

  const tokens = m['tokens'];
  const model = str(m['model']);
  if (tokens && typeof tokens === 'object' && model) {
    emit('model.response', `usage\n${id}`, { model, provider: 'google', usage: readGeminiTokens(tokens) });
  }

  const calls = Array.isArray(m['toolCalls']) ? m['toolCalls'] : [];
  for (const c of calls) {
    if (!c || typeof c !== 'object') continue;
    const call = c as Record<string, unknown>;
    const status = str(call['status']);
    const name = str(call['name']);
    const callId = str(call['id']) ?? `${id}:${name}`;
    // Only terminal calls: a scheduled/executing one is re-appended when it ends.
    if (!name || (status !== 'success' && status !== 'error' && status !== 'cancelled')) continue;
    const when = str(call['timestamp']) ?? at;
    emit(status === 'success' ? 'tool.completed' : 'tool.failed', `tool\n${callId}`, {
      tool_name: name,
      tool_call_id: str(call['id']),
    }, when);
    // `result` is the tool's output (file contents, command output): never read.
    const args = (call['args'] ?? {}) as Record<string, unknown>;
    const path = str(args['file_path']) ?? str(args['absolute_path']);
    const command = str(args['command']);
    if (name === 'run_shell_command' && command) emit('command.executed', `cmd\n${callId}`, { command }, when);
    else if (name === 'read_file' && path) emit('file.read', `file\n${callId}`, { path }, when);
    else if (name === 'write_file' && path) {
      emit('file.changed', `file\n${callId}`, { path, change_kind: 'create', ...countEditLines('Write', args) }, when);
    } else if (name === 'replace' && path) {
      emit('file.changed', `file\n${callId}`, { path, change_kind: 'edit', ...countEditLines('Edit', args) }, when);
    }
  }
  return events;
}

/**
 * Gemini API usageMetadata as the CLI records it. promptTokenCount INCLUDES
 * the cached tokens and candidatesTokenCount EXCLUDES thoughts; the normalized
 * shape wants input exclusive of cache and output inclusive of reasoning (the
 * Codex convention), so both are adjusted. Tool-use prompt tokens are input.
 */
export function readGeminiTokens(raw: unknown): TokenUsage {
  const t = (raw ?? {}) as Record<string, unknown>;
  const cached = num(t['cached']);
  const thoughts = num(t['thoughts']);
  return {
    ...emptyUsage(),
    input_tokens: Math.max(0, num(t['input']) - cached) + num(t['tool']),
    cached_input_tokens: cached,
    output_tokens: num(t['output']) + thoughts,
    reasoning_output_tokens: thoughts,
  };
}

/**
 * Gemini CLI's own rule for "not something the user typed" (isIgnoredUserContent
 * in 0.61): slash commands, `?` help, and the `<session_context>` block it
 * injects as a user message at the start of every session.
 */
function isIgnoredUserContent(text: string): boolean {
  return /^(?:[/?]|<session_context>|<hook_context>)/.test(text) || text.length === 0;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((p) => (p && typeof p === 'object' ? str((p as Record<string, unknown>)['text']) ?? '' : ''))
    .join('');
  return text || undefined;
}

/** `tmp/<project>/.project_root`, next to the chats/ folder the file sits in. */
const projectRoots = new Map<string, string | undefined>();
function projectOf(file: string): string | undefined {
  const parts = file.split(sep);
  const chats = parts.lastIndexOf('chats');
  if (chats < 1) return undefined;
  const dir = parts.slice(0, chats).join(sep);
  if (!projectRoots.has(dir)) {
    let root: string | undefined;
    try {
      root = readFileSync(join(dir, '.project_root'), 'utf8').trim() || undefined;
    } catch {
      root = undefined;
    }
    projectRoots.set(dir, root);
  }
  return projectRoots.get(dir);
}

function wrap(
  sessionId: string,
  project: string | undefined,
  occurredAt: string,
  event_type: NormalizedEvent['event']['event_type'],
  key: string,
  payload: Record<string, unknown>,
): NormalizedEvent {
  return {
    event: { occurred_at: occurredAt, session_id: sessionId, agent: 'gemini_cli', event_type, payload },
    cwd: project,
    repo: project ? { project_path: project } : undefined,
    eventId: deterministicEventId(`gemini_cli\n${sessionId}\n${key}`),
  };
}
