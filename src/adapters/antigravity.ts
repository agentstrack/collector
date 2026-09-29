import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AccountIdentity,
  AgentAdapter,
  DetectionResult,
  HealthStatus,
  NormalizeContext,
  NormalizedEvent,
  PollContext,
} from './types.js';
import { safeJsonParse, str } from './types.js';
import { readAntigravityAccount } from './account.js';
import { countEditLines } from './claude.js';
import { int, msg, text, timestampMs } from './protobuf.js';
import { emptyUsage } from '../schema.js';
import { deriveTitle } from '../sessions/title.js';
import { deterministicEventId } from '../queue/event-id.js';

/**
 * Google Antigravity CLI (`agy`) adapter.
 *
 * Source: `~/.gemini/antigravity-cli/conversations/<conversation id>.db`, one
 * SQLite database per conversation. Verified against agy 1.2.13 on real data
 * (62 conversations); field numbers come from the protobuf descriptors
 * embedded in the agy binary, not from guessing at bytes.
 *
 *   steps(idx, step_type, status, metadata, step_payload, …)
 *     step_type  CORTEX_STEP_TYPE_*: 14 USER_INPUT, 15 PLANNER_RESPONSE,
 *                132 GENERIC (every tool call in 1.2.x), 8/9/21/… legacy
 *                per-tool types — any step whose metadata holds a tool_call
 *                is treated as one.
 *     status     CORTEX_STEP_STATUS_*: 3 DONE, 5 CLEARED, 4 INVALID,
 *                6 CANCELED, 7 ERROR, 12 INTERRUPTED; 1/2/8/9/11 in flight.
 *     metadata   CortexStepMetadata: 1 created_at, 32 started_at,
 *                8 completed_at, 4 tool_call {1 id, 2 name, 3 arguments_json},
 *                9 model_usage (ModelUsageStats) {2 input_tokens — excludes
 *                cache reads, 5 cache_read_tokens, 4 cache_write_tokens,
 *                3 output_tokens = 9 thinking + 10 response, 7 message_id}.
 *     step_payload  field 19 = CortexStepUserInput {2 user_response, 1 query}.
 *   gen_metadata(idx, data)  1 = ChatModelMetadata {19 response_model,
 *                4 usage.7 message_id} — the only place the model NAME lives.
 *   trajectory_metadata_blob('main')  CortexTrajectoryMetadata {2 created_at,
 *                1 workspaces {1 folder uri, 4 branch_name}, 5 parent id}.
 *
 * Token usage IS recorded, per model call, so each planner response becomes a
 * model.response. Headless (`agy -p`) conversations carry no workspace: those
 * sessions have no cwd rather than a guessed one.
 *
 * THESE ARE LIVE DATABASES agy is writing. They are never opened in place: a
 * changed conversation is copied (db + wal) to a private temp dir and read
 * there, so the collector cannot lock, checkpoint or leave -shm files in the
 * agent's directory. A copy torn by a concurrent write fails to open and is
 * simply retried on the next cycle.
 */
export const ANTIGRAVITY_DIR = join(homedir(), '.gemini', 'antigravity-cli');

const DEFAULT_BACKFILL_DAYS = 7;
const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const COMPLETED = new Set([3, 5]); // DONE, CLEARED (history cleared after it ran)
const FAILED = new Set([4, 6, 7, 12]); // INVALID, CANCELED, ERROR, INTERRUPTED

const MTIME_PREFIX = 'antigravity:mtime:';
const CURSOR_PREFIX = 'antigravity:idx:';

interface StepRow {
  idx: number;
  step_type: number;
  status: number;
  metadata: Uint8Array | null;
  step_payload: Uint8Array | null;
}

interface Conversation {
  id: string;
  cwd?: string;
  branch?: string;
  /** step idx + ordinal within the step → a stable event id across re-reads. */
  seed: (idx: number, i: number) => string;
}

export class AntigravityAdapter implements AgentAdapter {
  readonly id = 'antigravity';

  constructor(
    private readonly dir: string = ANTIGRAVITY_DIR,
    private readonly backfillDays: number = DEFAULT_BACKFILL_DAYS,
  ) {}

  private get conversationsDir(): string {
    return join(this.dir, 'conversations');
  }

  async detect(): Promise<DetectionResult> {
    if (!existsSync(this.conversationsDir)) {
      return { installed: false, watchPaths: [], note: `No conversations under ${this.conversationsDir}` };
    }
    // Nothing for the tailer: these are databases, read through poll().
    return { installed: true, watchPaths: [] };
  }

  async health(): Promise<HealthStatus> {
    const detection = await this.detect();
    if (!detection.installed) return { healthy: false, filesTracked: 0, error: detection.note };
    return { healthy: true, filesTracked: this.databases().length };
  }

  normalize(_line: string, _ctx: NormalizeContext): NormalizedEvent[] {
    return [];
  }

  account(): AccountIdentity | undefined {
    return readAntigravityAccount(join(this.dir, 'log'));
  }

  async poll(ctx: PollContext): Promise<NormalizedEvent[]> {
    const floor = Date.now() - this.backfillDays * 86_400_000;
    const events: NormalizedEvent[] = [];
    for (const name of this.databases()) {
      const id = name.slice(0, -'.db'.length);
      const path = join(this.conversationsDir, name);
      const mtime = Math.max(mtimeOf(path), mtimeOf(`${path}-wal`));
      if (mtime < floor && ctx.getMeta(CURSOR_PREFIX + id) === null) continue;
      if (ctx.getMeta(MTIME_PREFIX + id) === String(mtime)) continue; // unchanged since last read
      try {
        events.push(...this.readConversation(path, id, ctx));
        ctx.setMeta(MTIME_PREFIX + id, String(mtime));
      } catch {
        // Torn copy or a schema this build does not know: retried next cycle.
        // The message is not logged — it can quote the blob it choked on.
      }
    }
    return events;
  }

  private databases(): string[] {
    try {
      return readdirSync(this.conversationsDir).filter((n) => n.endsWith('.db'));
    } catch {
      return [];
    }
  }

  private readConversation(path: string, id: string, ctx: PollContext): NormalizedEvent[] {
    const tmp = mkdtempSync(join(tmpdir(), 'agentstrack-agy-'));
    try {
      const copy = join(tmp, 'c.db');
      copyFileSync(path, copy);
      if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);
      const db = new Database(copy, { readonly: true, fileMustExist: true });
      try {
        return this.conversationEvents(db, id, ctx);
      } finally {
        db.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  private conversationEvents(db: Database.Database, id: string, ctx: PollContext): NormalizedEvent[] {
    const meta = (
      db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get() as
        | { data: Uint8Array | null }
        | undefined
    )?.data;
    const conv: Conversation = {
      id,
      cwd: fileUri(text(meta, 1, 1)),
      branch: text(meta, 1, 4),
      seed: (idx, i) => `antigravity\n${id}\n${idx}\n${i}`,
    };

    // message_id → model name. The step only carries a numeric model enum.
    const models = new Map<string, string>();
    let lastModel: string | undefined;
    for (const { data } of db.prepare('SELECT data FROM gen_metadata ORDER BY idx').all() as { data: Uint8Array }[]) {
      const chat = msg(data, 1);
      const model = text(chat, 19);
      const messageId = text(chat, 4, 7);
      if (!model) continue;
      lastModel = model;
      if (messageId) models.set(messageId, model);
    }

    const events: NormalizedEvent[] = [];
    const stored = ctx.getMeta(CURSOR_PREFIX + id);
    const cursor = stored === null ? -1 : Number(stored);
    const rows = db
      .prepare('SELECT idx, step_type, status, metadata, step_payload FROM steps WHERE idx > ? ORDER BY idx')
      .all(cursor) as StepRow[];

    if (stored === null) {
      const createdMs = timestampMs(meta, 2) || timestampMs(rows[0]?.metadata, 1);
      if (createdMs) {
        events.push(
          wrap(conv, createdMs, 'session.started', -1, 0, {
            external_session_id: id,
            cwd: conv.cwd,
            parent_session_id: text(meta, 5),
            model: lastModel,
            provider: 'google',
          }),
        );
      }
    }

    // The cursor stops before the first step still in flight: it is re-read
    // (and its terminal events emitted) once agy finishes it. Steps after it
    // are emitted now; their deterministic ids absorb the re-read.
    let next = cursor;
    let blocked = false;
    for (const row of rows) {
      const terminal = COMPLETED.has(row.status) || FAILED.has(row.status);
      if (!terminal) {
        blocked = true;
        continue;
      }
      if (!blocked) next = row.idx;
      events.push(...stepEvents(conv, row, models, lastModel));
    }
    ctx.setMeta(CURSOR_PREFIX + id, String(next));
    return events;
  }
}

function stepEvents(
  conv: Conversation,
  row: StepRow,
  models: Map<string, string>,
  lastModel: string | undefined,
): NormalizedEvent[] {
  const m = row.metadata;
  const at = timestampMs(m, 1);
  if (!at) return [];
  const out: NormalizedEvent[] = [];
  const emit = (type: NormalizedEvent['event']['event_type'], payload: Record<string, unknown>, atMs = at) =>
    out.push(wrap(conv, atMs, type, row.idx, out.length, payload));

  if (row.step_type === USER_INPUT) {
    const input = msg(row.step_payload, 19);
    const prompt = text(input, 2) ?? text(input, 1);
    if (prompt) emit('user.prompted', { prompt_chars: prompt.length, prompt_text: prompt, derived_title: deriveTitle(prompt) });
    return out;
  }

  const usage = msg(m, 9);
  if (row.step_type === PLANNER_RESPONSE && usage) {
    emit(
      'model.response',
      {
        model: models.get(text(usage, 7) ?? '') ?? lastModel ?? 'unknown',
        provider: 'google',
        usage: {
          ...emptyUsage(),
          input_tokens: int(usage, 2),
          cached_input_tokens: int(usage, 5),
          cache_creation_input_tokens: int(usage, 4),
          output_tokens: int(usage, 3),
          // thinking_output_tokens is a subset of output_tokens, as in Codex.
          reasoning_output_tokens: int(usage, 9),
        },
      },
      timestampMs(m, 8) || at,
    );
  }

  const call = msg(m, 4);
  const tool = text(call, 2);
  if (!tool) return out;
  const start = timestampMs(m, 32) || at;
  const end = timestampMs(m, 8);
  emit(
    COMPLETED.has(row.status) ? 'tool.completed' : 'tool.failed',
    { tool_name: tool, tool_call_id: text(call, 1), duration_ms: end > start ? end - start : 0 },
    start,
  );

  // toolAction/toolSummary are the model's own prose about the call: never read.
  const args = safeJsonParse(text(call, 3) ?? '') ?? {};
  const command = str(args['CommandLine']);
  if (tool === 'run_command' && command) emit('command.executed', { command }, start);
  const read = str(args['AbsolutePath']);
  if (tool === 'view_file' && read) emit('file.read', { path: read }, start);
  const target = str(args['TargetFile']);
  if (target && tool === 'write_to_file') {
    emit('file.changed', { path: target, change_kind: 'create', ...countEditLines('Write', { content: args['CodeContent'] }) }, start);
  } else if (target && tool === 'replace_file_content') {
    emit(
      'file.changed',
      {
        path: target,
        change_kind: 'edit',
        ...countEditLines('Edit', { old_string: args['TargetContent'], new_string: args['ReplacementContent'] }),
      },
      start,
    );
  }
  return out;
}

function wrap(
  conv: Conversation,
  atMs: number,
  event_type: NormalizedEvent['event']['event_type'],
  idx: number,
  i: number,
  payload: Record<string, unknown>,
): NormalizedEvent {
  return {
    event: {
      occurred_at: new Date(atMs).toISOString(),
      session_id: conv.id,
      agent: 'antigravity',
      event_type,
      payload,
    },
    cwd: conv.cwd,
    repo: conv.cwd ? { project_path: conv.cwd, ...(conv.branch ? { branch: conv.branch } : {}) } : undefined,
    eventId: deterministicEventId(`${conv.seed(idx, i)}\n${event_type}`),
  };
}

function fileUri(uri: string | undefined): string | undefined {
  if (!uri?.startsWith('file://')) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
