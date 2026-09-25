import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { deterministicEventId } from '../queue/event-id.js';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { AccountIdentity, AgentAdapter, DetectionResult, HealthStatus, NormalizeContext, NormalizedEvent } from './types.js';
import { newestJsonl, num, readHeadLines, safeJsonParse, str } from './types.js';
import { readClaudeAccount, readClaudeLiveSessions } from './account.js';
import { emptyUsage, type TokenUsage } from '../schema.js';
import { deriveTitle } from '../sessions/title.js';

/**
 * Claude Code adapter.
 *
 * Source: ~/.claude/projects/<path-slug>/<session-uuid>.jsonl
 *
 * Verified line shapes (Claude Code 2.1.x):
 *   {"type":"user","message":{"role":"user","content":"..."},"timestamp":"…",
 *    "sessionId":"…","cwd":"…","gitBranch":"…","version":"…"}
 *   {"type":"assistant","message":{"model":"claude-opus-5","content":[…],
 *    "usage":{"input_tokens":2,"cache_creation_input_tokens":39728,
 *             "cache_read_input_tokens":26254,"output_tokens":505,
 *             "output_tokens_details":{"thinking_tokens":257}}},"timestamp":"…"}
 *
 * Tool calls appear as tool_use / tool_result blocks inside message.content.
 * One API response is written as SEVERAL assistant lines — one per content
 * block (thinking, text, tool_use) — each repeating the same message.id and
 * the same usage. Usage is therefore billed once per message.id, not per line.
 *
 * Sub-agents (the Agent tool, and Workflow scripts) write their own transcript
 * under <session-uuid>/subagents/[workflows/<wf>/]agent-<id>.jsonl, with the
 * parent's sessionId on every line, isSidechain: true and an agentId. A sibling
 * agent-<id>.meta.json carries {"agentType","description","toolUseId",…}. Every
 * event from such a line is stamped sidechain/agent_id/agent_kind/agent_type
 * so the server can attribute the sub-agent's own usage to it.
 */
export const CLAUDE_DIR = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');

/**
 * Claude Code's own markup on a user line: slash-command echoes and background
 * task completions. They are not typed by a human and must not count as
 * prompts or as human-active time.
 */
const MARKUP_PROMPT = /^<(task-notification|local-command-stdout|command-message|command-name)[\s>]/;

interface FileState {
  /** message.id of the last assistant line whose usage was emitted. */
  lastMessageId?: string;
  /** tool_use id → tool name and extras; tool_result blocks carry only the id. */
  tools: Map<string, { name: string; extra: Record<string, unknown> }>;
  /** Sub-agent identity of this file: undefined = not looked up yet, null = a main transcript. */
  agent?: AgentStamp | null;
}

interface AgentStamp {
  agent_id?: string;
  agent_kind: 'subagent' | 'workflow';
  agent_type?: string;
}

const ULTRACODE = /\bultracode\b/i;

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude_code';

  /** Cross-line facts within one transcript: a message's lines are contiguous. */
  private readonly fileState = new Map<string, FileState>();

  /**
   * Every Claude config directory seen: the daemon's own, the default one, each ~/.claude-*
   * profile holding a login, and any directory a running process was launched
   * with. Profile launchers (CLAUDE_CONFIG_DIR per account) are the reason.
   */
  private readonly configDirs = new Set<string>([resolve(CLAUDE_DIR), join(homedir(), '.claude')]);
  /**
   * One entry per real projects/ folder — profiles often share one via
   * symlink — with the config dirs writing into it. `path` is the first
   * owner's own spelling, not the realpath: event ids hash the file path, so
   * the daemon's default ~/.claude/projects must keep the name it always had.
   */
  private projectOwners: { path: string; dirs: string[] }[] = [];
  /**
   * sessionId -> the login it ran under, pinned while its process was alive.
   * Kept after the process exits: its last lines are often tailed after that.
   * ponytail: grows by one small entry per session for the daemon's lifetime; prune if that ever matters.
   */
  private readonly sessionAccounts = new Map<string, AccountIdentity>();

  /**
   * Runs once per scan cycle (the daemon calls it before tailing), so this is
   * also where the live session -> login map is refreshed.
   */
  async detect(): Promise<DetectionResult> {
    this.discover();
    const watchPaths = this.projectOwners.map((o) => o.path);
    if (watchPaths.length === 0) {
      return { installed: false, watchPaths: [], note: `No transcripts at ${join(CLAUDE_DIR, 'projects')}` };
    }
    let version: string | undefined;
    try {
      // The version is stamped on every transcript line; read one cheaply.
      const projects = readdirSync(watchPaths[0]!).slice(0, 5);
      for (const project of projects) {
        const file = newestJsonl(join(watchPaths[0]!, project));
        if (!file) continue;
        version = readVersionFromTranscript(file);
        if (version) break;
      }
    } catch {
      // Unreadable project dir is not fatal; the tailer reports per-file errors.
    }
    return { installed: true, version, watchPaths };
  }

  private discover(): void {
    const home = homedir();
    try {
      for (const name of readdirSync(home)) {
        if (!name.startsWith('.claude-')) continue;
        const dir = join(home, name);
        if (safeRealpath(join(dir, '.claude.json'))) this.configDirs.add(dir);
      }
    } catch {
      // unreadable home: the daemon's own dir still works
    }

    // Live sessions first: they can name a config dir no rule above found.
    const sessionDirs = new Set([...this.configDirs].flatMap((d) => safeRealpath(join(d, 'sessions')) ?? []));
    for (const dir of sessionDirs) {
      for (const live of readClaudeLiveSessions(dir)) {
        this.configDirs.add(live.configDir);
        const account = readClaudeAccount(live.configDir);
        if (account) this.sessionAccounts.set(live.sessionId, account);
      }
    }

    // Set order puts the daemon's own dir first, so it keeps its spelling.
    const owners = new Map<string, { path: string; dirs: string[] }>();
    for (const dir of this.configDirs) {
      const path = join(dir, 'projects');
      const real = safeRealpath(path);
      if (!real) continue;
      const owner = owners.get(real);
      if (owner) owner.dirs.push(dir);
      else owners.set(real, { path, dirs: [dir] });
    }
    this.projectOwners = [...owners.values()];
  }

  /**
   * The login a line belongs to. A session pinned by its live process wins;
   * otherwise a projects/ folder only one login writes into names that login.
   * A folder several logins share names nobody — the currently signed-in
   * account there is a guess, and a guess reads exactly like a fact.
   */
  private accountFor(sessionId: string, sourceFile: string): AccountIdentity | undefined {
    const live = this.sessionAccounts.get(sessionId);
    if (live) return live;
    for (const { path, dirs } of this.projectOwners) {
      if (sourceFile.startsWith(path + sep)) return dirs.length === 1 ? readClaudeAccount(dirs[0]!) : undefined;
    }
    return undefined;
  }

  async health(): Promise<HealthStatus> {
    const detection = await this.detect();
    if (!detection.installed) return { healthy: false, filesTracked: 0, error: detection.note };
    let filesTracked = 0;
    try {
      for (const root of detection.watchPaths) {
        for (const project of readdirSync(root)) {
          filesTracked += readdirSync(join(root, project)).filter((f) => f.endsWith('.jsonl')).length;
        }
      }
    } catch (error) {
      return { healthy: false, filesTracked: 0, error: error instanceof Error ? error.message : String(error) };
    }
    return { healthy: true, filesTracked };
  }

  normalize(line: string, ctx: NormalizeContext): NormalizedEvent[] {
    const raw = safeJsonParse(line);
    if (!raw) return [];

    const type = str(raw['type']);
    const sessionId = str(raw['sessionId']) ?? str(raw['session_id']);
    const occurredAt = str(raw['timestamp']);
    if (!type || !sessionId || !occurredAt) return [];

    const agentVersion = str(raw['version']);
    const cwd = str(raw['cwd']);
    const branch = str(raw['gitBranch']);
    const repo = branch || cwd ? { branch, project_path: cwd } : undefined;

    const base = {
      occurred_at: occurredAt,
      session_id: sessionId,
      agent: 'claude_code' as const,
      agent_version: agentVersion,
    };
    let state = this.fileState.get(ctx.sourceFile);
    if (!state) {
      state = { tools: new Map() };
      this.fileState.set(ctx.sourceFile, state);
    }
    state.agent ??= readAgentStamp(ctx.sourceFile);

    // A sub-agent's line, whether in its own file or (older releases) inline.
    const agent = state.agent ?? (raw['isSidechain'] === true ? { agent_kind: 'subagent' as const } : null);
    const stamp = agent ? { sidechain: true, ...agent, agent_id: str(raw['agentId']) ?? agent.agent_id } : {};

    const account = this.accountFor(sessionId, ctx.sourceFile);
    const wrap = (
      event_type: NormalizedEvent['event']['event_type'],
      payload: Record<string, unknown>,
    ): NormalizedEvent => ({
      event: { ...base, event_type, payload: { ...payload, ...stamp } },
      cwd,
      repo,
      ...(account ? { account } : {}),
    });

    if (type === 'user') return this.normalizeUser(raw, state, wrap);
    if (type === 'assistant') return this.normalizeAssistant(raw, state, wrap);
    return [];
  }

  private normalizeUser(
    raw: Record<string, unknown>,
    state: FileState,
    wrap: (t: NormalizedEvent['event']['event_type'], p: Record<string, unknown>) => NormalizedEvent,
  ): NormalizedEvent[] {
    const message = (raw['message'] ?? {}) as Record<string, unknown>;
    const content = message['content'];

    // A "user" line is either a real human prompt or a tool result the agent
    // fed back to itself. Only the former is human interaction time. A prompt
    // arrives as a string, or as text/image blocks when something was pasted.
    let text: string | undefined;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      const events: NormalizedEvent[] = [];
      const texts: string[] = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b['type'] === 'text') {
          const t = str(b['text']);
          if (t) texts.push(t);
          continue;
        }
        if (b['type'] !== 'tool_result') continue;
        const id = str(b['tool_use_id']);
        const failed = b['is_error'] === true;
        const started = id ? state.tools.get(id) : undefined;
        events.push(
          wrap(failed ? 'tool.failed' : 'tool.completed', {
            tool_name: started?.name ?? 'unknown',
            tool_call_id: id,
            ...started?.extra,
          }),
        );
        if (id) state.tools.delete(id);
      }
      if (events.length > 0) return events;
      text = texts.join('\n');
    }

    if (!text) return [];
    // Meta lines (command output, system reminders) and Claude Code's own
    // markup are not prompts.
    if (raw['isMeta'] === true || str(raw['promptSource']) === 'system') return [];
    if (MARKUP_PROMPT.test(text.trimStart())) return [];

    return [
      wrap('user.prompted', {
        prompt_chars: text.length,
        prompt_text: text,
        derived_title: deriveTitle(text),
        // A boolean computed here, before the privacy pipeline strips the
        // text, so it survives metadata mode without the prompt travelling.
        ...(ULTRACODE.test(text) ? { ultracode: true } : {}),
      }),
    ];
  }

  private normalizeAssistant(
    raw: Record<string, unknown>,
    state: FileState,
    wrap: (t: NormalizedEvent['event']['event_type'], p: Record<string, unknown>) => NormalizedEvent,
  ): NormalizedEvent[] {
    const message = (raw['message'] ?? {}) as Record<string, unknown>;
    const model = str(message['model']);
    // Claude Code stamps '<synthetic>' on locally generated messages (interrupts,
    // injected notices). They are not model calls and must not reach the model
    // analytics or the cost table.
    if (!model || model.startsWith('<')) return [];

    const events: NormalizedEvent[] = [];
    // Every line of one response repeats the same usage; bill it once.
    const messageId = str(message['id']) ?? str(raw['requestId']);
    if (!messageId || messageId !== state.lastMessageId) {
      state.lastMessageId = messageId;
      events.push({
        ...wrap('model.response', {
          model,
          provider: 'anthropic',
          usage: readUsage(message['usage']),
          stop_reason: str(message['stop_reason']),
        }),
        // Keyed on the message, not the line: a restart between two lines of
        // the same response must dedupe on the server, not bill twice.
        eventId: messageId ? deterministicEventId(`claude_code\nmodel.response\n${messageId}`) : undefined,
      });
    }

    const content = message['content'];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b['type'] !== 'tool_use') continue;
        const toolName = str(b['name']) ?? 'unknown';
        const toolId = str(b['id']);
        const input = (b['input'] ?? {}) as Record<string, unknown>;
        const extra = toolExtras(toolName, input);
        if (toolId) state.tools.set(toolId, { name: toolName, extra });
        events.push(wrap('tool.started', { tool_name: toolName, tool_call_id: toolId, ...extra }));

        // Bash invocations are the interesting ones for command analytics.
        const command = str(input['command']);
        if (toolName === 'Bash' && command) {
          events.push(wrap('command.executed', { command }));
        }
        const filePath = str(input['file_path']);
        if (filePath && (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit')) {
          events.push(
            wrap('file.changed', {
              path: filePath,
              change_kind: toolName === 'Write' ? 'create' : 'edit',
              ...countEditLines(toolName, input),
            }),
          );
        }
        if (filePath && toolName === 'Read') {
          events.push(wrap('file.read', { path: filePath }));
        }
      }
    }
    return events;
  }
}

/**
 * What a Skill, Agent or Workflow call invoked — the name only, never the
 * prompt or the script body. Everything else has no extras.
 */
function toolExtras(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (toolName === 'Skill') extra['skill'] = str(input['skill']);
  if (toolName === 'Agent') {
    extra['subagent_type'] = str(input['subagent_type']);
    extra['description'] = str(input['description']);
  }
  if (toolName === 'Workflow') extra['workflow_name'] = workflowName(str(input['script']));
  for (const key of Object.keys(extra)) if (extra[key] === undefined) delete extra[key];
  return extra;
}

/** `name: '…'` out of the script's `export const meta = {…}` header. Absent when it is not that simple. */
function workflowName(script: string | undefined): string | undefined {
  // ponytail: a regex over the first 4 KB, not a parser — meta is by convention the first export.
  const m = /\bname:\s*(['"`])([^'"`\r\n]{1,120})\1/.exec(script?.slice(0, 4096) ?? '');
  return m?.[2];
}

/**
 * Sub-agent identity of a transcript, from its path and sibling meta file.
 * Null for a main transcript. Read once per file; the meta file is written
 * when the agent is spawned, before its first line.
 */
function readAgentStamp(file: string): AgentStamp | null {
  const m = /[\\/]subagents[\\/](?:.*[\\/])?agent-([^\\/]+)\.jsonl$/.exec(file);
  if (!m) return null;
  const stamp: AgentStamp = {
    agent_id: m[1],
    agent_kind: /[\\/]subagents[\\/]workflows[\\/]/.test(file) ? 'workflow' : 'subagent',
  };
  try {
    const meta = safeJsonParse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    // Real key is agentType (Claude Code 2.1.x); the rest are tolerated spellings.
    const type = meta && (str(meta['agentType']) ?? str(meta['subagent_type']) ?? str(meta['type']) ?? str(meta['label']));
    if (type) stamp.agent_type = type;
  } catch {
    // No meta file: kind and id still come from the path.
  }
  return stamp;
}

/** Reads the `version` field off the first line that carries one. */
function readVersionFromTranscript(file: string): string | undefined {
  for (const line of readHeadLines(file)) {
    const parsed = safeJsonParse(line);
    const version = parsed ? str(parsed['version']) : undefined;
    if (version) return version;
  }
  return undefined;
}

/**
 * Maps Claude Code's usage block onto the normalized shape.
 *
 * thinking_tokens sits under output_tokens_details and is a SUBSET of
 * output_tokens — it must not be added on top, or thinking gets billed twice.
 */
export function readUsage(raw: unknown): TokenUsage {
  const usage = (raw ?? {}) as Record<string, unknown>;
  const details = (usage['output_tokens_details'] ?? {}) as Record<string, unknown>;
  return {
    ...emptyUsage(),
    input_tokens: num(usage['input_tokens']),
    cached_input_tokens: num(usage['cache_read_input_tokens']),
    cache_creation_input_tokens: num(usage['cache_creation_input_tokens']),
    output_tokens: num(usage['output_tokens']),
    reasoning_output_tokens: num(details['thinking_tokens']),
  };
}

/**
 * Line deltas for one edit, derived from the tool input.
 *
 * It has to happen here: the privacy pipeline drops old_string/new_string
 * before anything is uploaded, so no later stage can recover the counts. Lines
 * present on both sides are not counted, which matches what `git diff
 * --numstat` reports for the same change.
 */
export function countEditLines(
  toolName: string,
  input: Record<string, unknown>,
): { lines_added: number; lines_removed: number } {
  if (toolName === 'Write') return { lines_added: splitLines(str(input['content'])).length, lines_removed: 0 };
  if (toolName === 'NotebookEdit') return diffLines(str(input['old_source']), str(input['new_source']));
  return diffLines(str(input['old_string']), str(input['new_string']));
}

function splitLines(text: string | undefined): string[] {
  if (!text) return [];
  // A trailing newline terminates the last line, it does not start a new one.
  return text.replace(/\n$/, '').split('\n');
}

/** Multiset difference — a line that survives the edit is neither added nor removed. */
function diffLines(before: string | undefined, after: string | undefined): { lines_added: number; lines_removed: number } {
  const remaining = new Map<string, number>();
  for (const line of splitLines(before)) remaining.set(line, (remaining.get(line) ?? 0) + 1);

  let added = 0;
  for (const line of splitLines(after)) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) remaining.set(line, left - 1);
    else added += 1;
  }

  let removed = 0;
  for (const count of remaining.values()) removed += count;
  return { lines_added: added, lines_removed: removed };
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}
