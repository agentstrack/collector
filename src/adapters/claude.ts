import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountIdentity, AgentAdapter, DetectionResult, HealthStatus, NormalizeContext, NormalizedEvent } from './types.js';
import { num, safeJsonParse, str } from './types.js';
import { readClaudeAccount } from './account.js';
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
 */
export const CLAUDE_DIR = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude_code';

  async detect(): Promise<DetectionResult> {
    if (!existsSync(PROJECTS_DIR)) {
      return { installed: false, watchPaths: [], note: `No transcripts at ${PROJECTS_DIR}` };
    }
    let version: string | undefined;
    try {
      // The version is stamped on every transcript line; read one cheaply.
      const projects = readdirSync(PROJECTS_DIR).slice(0, 5);
      for (const project of projects) {
        const files = readdirSync(join(PROJECTS_DIR, project)).filter((f) => f.endsWith('.jsonl'));
        if (files.length === 0) continue;
        // The version is stamped on every transcript line; read the newest one
        // rather than reporting a placeholder string as the agent version.
        version = readVersionFromTranscript(join(PROJECTS_DIR, project, files[0]!));
        if (version) break;
      }
    } catch {
      // Unreadable project dir is not fatal; the tailer reports per-file errors.
    }
    return { installed: true, version, watchPaths: [PROJECTS_DIR] };
  }

  /**
   * The account Claude Code is signed in as right now.
   *
   * ~/.claude.json carries a single `oauthAccount` and is rewritten on account
   * switch, so this is a live reading with no history behind it. The daemon
   * attaches it only to events written after the collector started — a
   * transcript that was already on disk cannot be attributed retroactively and
   * gets no account rather than the wrong one.
   */
  account(): AccountIdentity | undefined {
    return readClaudeAccount(CLAUDE_DIR);
  }

  async health(): Promise<HealthStatus> {
    const detection = await this.detect();
    if (!detection.installed) return { healthy: false, filesTracked: 0, error: detection.note };
    let filesTracked = 0;
    try {
      for (const project of readdirSync(PROJECTS_DIR)) {
        filesTracked += readdirSync(join(PROJECTS_DIR, project)).filter((f) => f.endsWith('.jsonl')).length;
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
    const wrap = (
      event_type: NormalizedEvent['event']['event_type'],
      payload: Record<string, unknown>,
    ): NormalizedEvent => ({ event: { ...base, event_type, payload }, cwd, repo });

    void ctx;

    if (type === 'user') return this.normalizeUser(raw, wrap);
    if (type === 'assistant') return this.normalizeAssistant(raw, wrap);
    return [];
  }

  private normalizeUser(
    raw: Record<string, unknown>,
    wrap: (t: NormalizedEvent['event']['event_type'], p: Record<string, unknown>) => NormalizedEvent,
  ): NormalizedEvent[] {
    const message = (raw['message'] ?? {}) as Record<string, unknown>;
    const content = message['content'];

    // A "user" line is either a real human prompt or a tool result the agent
    // fed back to itself. Only the former is human interaction time.
    if (Array.isArray(content)) {
      const events: NormalizedEvent[] = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b['type'] !== 'tool_result') continue;
        const failed = b['is_error'] === true;
        events.push(
          wrap(failed ? 'tool.failed' : 'tool.completed', {
            tool_name: str(b['name']) ?? 'unknown',
            tool_call_id: str(b['tool_use_id']),
          }),
        );
      }
      return events;
    }

    if (typeof content !== 'string') return [];
    // Meta lines (command output, system reminders) are not prompts.
    if (raw['isMeta'] === true || str(raw['promptSource']) === 'system') return [];

    return [
      wrap('user.prompted', {
        prompt_chars: content.length,
        prompt_text: content,
        derived_title: deriveTitle(content),
      }),
    ];
  }

  private normalizeAssistant(
    raw: Record<string, unknown>,
    wrap: (t: NormalizedEvent['event']['event_type'], p: Record<string, unknown>) => NormalizedEvent,
  ): NormalizedEvent[] {
    const message = (raw['message'] ?? {}) as Record<string, unknown>;
    const model = str(message['model']);
    // Claude Code stamps '<synthetic>' on locally generated messages (interrupts,
    // injected notices). They are not model calls and must not reach the model
    // analytics or the cost table.
    if (!model || model.startsWith('<')) return [];

    const events: NormalizedEvent[] = [
      wrap('model.response', {
        model,
        provider: 'anthropic',
        usage: readUsage(message['usage']),
        stop_reason: str(message['stop_reason']),
      }),
    ];

    const content = message['content'];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b['type'] !== 'tool_use') continue;
        const toolName = str(b['name']) ?? 'unknown';
        events.push(wrap('tool.started', { tool_name: toolName, tool_call_id: str(b['id']) }));

        // Bash invocations are the interesting ones for command analytics.
        const input = (b['input'] ?? {}) as Record<string, unknown>;
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
 * Maps Claude Code's usage block onto the normalized shape.
 *
 * thinking_tokens sits under output_tokens_details and is a SUBSET of
 * output_tokens — it must not be added on top, or thinking gets billed twice.
 */
/** Reads the `version` field off the first line that carries one. */
function readVersionFromTranscript(file: string): string | undefined {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n', 40)) {
      const parsed = safeJsonParse(line);
      const version = parsed ? str(parsed['version']) : undefined;
      if (version) return version;
    }
  } catch {
    // Unreadable transcript: absent version is better than a fabricated one.
  }
  return undefined;
}

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
