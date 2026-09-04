import Database from 'better-sqlite3';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type {
  AccountIdentity,
  AgentAdapter,
  DetectionResult,
  HealthStatus,
  NormalizeContext,
  NormalizedEvent,
  PollContext,
} from './types.js';
import { num, safeJsonParse, str } from './types.js';
import { readOpenCodeAccounts } from './account.js';
import { countEditLines } from './claude.js';
import { emptyUsage } from '../schema.js';
import { deriveTitle } from '../sessions/title.js';

/**
 * OpenCode adapter.
 *
 * Source: a SQLite database, not a log — `<data>/opencode.db`, where <data> is
 * `$XDG_DATA_HOME/opencode` (falling back to `~/.local/share/opencode`) and the
 * filename may be overridden by $OPENCODE_DB or suffixed with a release channel
 * (`opencode-dev.db`). That is what OpenCode 1.18 itself does, checked against
 * the shipped binary rather than assumed.
 *
 * Three tables matter:
 *   session — one row per session, already carrying running token totals, the
 *             provider's REAL cost, model, cwd, title and version.
 *   message — role + model per turn, JSON in `data`.
 *   part    — the timeline: text, tool calls with input/output and timings.
 *
 * THIS IS A LIVE DATABASE THE USER'S EDITOR IS WRITING TO. It is opened
 * read-only with a busy timeout and only short queries run on it. The
 * collector must never be the reason someone's session data is corrupted or
 * their editor blocks.
 *
 * Because there are no lines, normalize() has nothing to do and the adapter
 * implements poll() instead (see AgentAdapter.poll). Resumption uses the
 * spool's meta store: two cursors plus one marker per session whose
 * session.started has been emitted.
 */
export const OPENCODE_DATA_DIR =
  process.env['OPENCODE_DATA_DIR'] ??
  join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'opencode');

/**
 * Resolves the database file the way OpenCode does.
 *
 * $OPENCODE_DB wins (absolute path used as-is, relative resolved inside the
 * data dir). Otherwise release channels other than latest/beta/prod write to
 * `opencode-<channel>.db`; the channel is not discoverable from outside the
 * binary, so the plain file is preferred and a channel file is accepted as a
 * fallback rather than guessed at.
 */
export function resolveDbPath(dataDir: string = OPENCODE_DATA_DIR): string | undefined {
  const override = process.env['OPENCODE_DB'];
  if (override && override !== ':memory:') {
    const path = isAbsolute(override) ? override : join(dataDir, override);
    return existsSync(path) ? path : undefined;
  }

  const plain = join(dataDir, 'opencode.db');
  if (existsSync(plain)) return plain;

  try {
    const channel = readdirSync(dataDir)
      .filter((f) => /^opencode-[\w.-]+\.db$/.test(f))
      .sort();
    const first = channel[0];
    return first ? join(dataDir, first) : undefined;
  } catch {
    return undefined;
  }
}

/** How far back a first-ever poll reaches, matching the tailer's transcript horizon. */
/**
 * How far back to reach when no cursor exists yet — a fresh install, or one
 * whose cursors were reset to re-import history.
 *
 * This adapter reads a live database instead of tailing files, so it cannot
 * use the file-mtime walk the others do and needs its own floor. It was
 * hardcoded to 7 days, independently of `tracking.max_age_days`, which meant
 * widening that knob backfilled Claude Code and Codex fully and left OpenCode
 * still capped at a week: 4 of 19 sessions, with the other 15 emitting their
 * parts but never a `session.started`.
 */
const DEFAULT_BACKFILL_DAYS = 7;
/** Bounds one poll so a cold start drains over several cycles instead of one huge batch. */
const SESSION_LIMIT = 200;
const PART_LIMIT = 1000;

const CURSOR_SESSION_UPDATED = 'opencode:cursor:session_updated';
const CURSOR_PART_UPDATED = 'opencode:cursor:part_updated';
/**
 * `opencode:started:<session id>` = '1' once session.started went out. Sessions
 * are fetched by time_updated, so a cursor on time_created missed every session
 * that was created before one already seen and touched later — i.e. every
 * resumed session.
 */
const STARTED_PREFIX = 'opencode:started:';
/** How long a detect() may reuse the version it last read from the database. */
const VERSION_TTL_MS = 60_000;

interface SessionRow {
  id: string;
  parent_id: string | null;
  directory: string;
  title: string | null;
  version: string | null;
  agent: string | null;
  model: string | null;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  time_created: number;
  time_updated: number;
  time_compacting: number | null;
  time_archived: number | null;
}

interface PartRow {
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
  message_data: string;
  directory: string;
  version: string | null;
  model: string | null;
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = 'opencode';

  /** The one read-only handle, opened lazily; statements are prepared once per handle. */
  private conn?: { path: string; db: Database.Database; statements: Map<string, Database.Statement> };
  private version?: { readAt: number; value: string | undefined };

  constructor(
    private readonly dataDir: string = OPENCODE_DATA_DIR,
    private readonly backfillDays: number = DEFAULT_BACKFILL_DAYS,
  ) {}

  async detect(): Promise<DetectionResult> {
    const db = resolveDbPath(this.dataDir);
    if (!db) {
      return { installed: false, watchPaths: [], note: `No OpenCode database under ${this.dataDir}` };
    }
    // watchPaths stays empty on purpose: there is nothing here for the tailer
    // to read, and handing it a .db file would have it stream binary pages.
    return { installed: true, version: this.latestVersion(), watchPaths: [], note: db };
  }

  async health(): Promise<HealthStatus> {
    const detection = await this.detect();
    if (!detection.installed) return { healthy: false, filesTracked: 0, error: detection.note };
    try {
      const sessions = this.query<{ n: number }>('SELECT COUNT(*) AS n FROM session')[0]?.n ?? 0;
      return { healthy: true, filesTracked: sessions };
    } catch (error) {
      return {
        healthy: false,
        filesTracked: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** No-op: OpenCode has no log lines. Everything arrives through poll(). */
  normalize(_line: string, _ctx: NormalizeContext): NormalizedEvent[] {
    return [];
  }

  /*
   * There is deliberately no adapter-wide account(): OpenCode holds one active
   * account PER PROVIDER, and this machine's sessions span several. Answering
   * with "the" account would attribute an OpenAI session to an OpenRouter key.
   * Each event carries the identity of its own session's provider instead.
   */

  async poll(ctx: PollContext): Promise<NormalizedEvent[]> {
    if (!resolveDbPath(this.dataDir)) return [];
    const floor = Date.now() - this.backfillDays * 86_400_000;
    const cursor = (key: string): number => {
      const stored = Number(ctx.getMeta(key));
      return Number.isFinite(stored) && stored > 0 ? stored : floor;
    };

    const events: NormalizedEvent[] = [];
    const sessionUpdated = cursor(CURSOR_SESSION_UPDATED);
    const partUpdated = cursor(CURSOR_PART_UPDATED);

    const sessions = this.query<SessionRow>(
      `SELECT id, parent_id, directory, title, version, agent, model, cost,
              tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
              time_created, time_updated, time_compacting, time_archived
         FROM session
        WHERE time_updated > ?
        ORDER BY time_updated ASC
        LIMIT ?`,
      sessionUpdated,
      SESSION_LIMIT,
    );

    const accounts = readOpenCodeAccounts(this.dataDir);
    let maxUpdated = sessionUpdated;
    for (const row of sessions) {
      events.push(...this.sessionEvents(row, ctx, accounts));
      maxUpdated = Math.max(maxUpdated, row.time_updated);
    }

    const parts = this.query<PartRow>(
      `SELECT p.session_id, p.time_created, p.time_updated, p.data,
              m.data AS message_data, s.directory, s.version, s.model
         FROM part p
         JOIN message m ON m.id = p.message_id
         JOIN session s ON s.id = p.session_id
        WHERE p.time_updated > ?
        ORDER BY p.time_updated ASC
        LIMIT ?`,
      partUpdated,
      PART_LIMIT,
    );

    let maxPart = partUpdated;
    for (const row of parts) {
      events.push(...this.partEvents(row, accounts));
      maxPart = Math.max(maxPart, row.time_updated);
    }

    ctx.setMeta(CURSOR_SESSION_UPDATED, String(maxUpdated));
    ctx.setMeta(CURSOR_PART_UPDATED, String(maxPart));
    return events;
  }

  private sessionEvents(
    row: SessionRow,
    ctx: PollContext,
    accounts: Map<string, AccountIdentity>,
  ): NormalizedEvent[] {
    const { model, provider } = parseModel(row.model);
    const wrap = wrapper(row.id, row.version ?? undefined, row.directory, account(accounts, provider));
    const events: NormalizedEvent[] = [];

    if (ctx.getMeta(STARTED_PREFIX + row.id) === null) {
      ctx.setMeta(STARTED_PREFIX + row.id, '1');
      events.push(
        wrap(row.time_created, 'session.started', {
          external_session_id: row.id,
          cwd: row.directory,
          parent_session_id: row.parent_id ?? undefined,
          agent_mode: row.agent ?? undefined,
          model,
          provider,
          derived_title: row.title ?? undefined,
        }),
      );
    }

    // The session row holds RUNNING TOTALS, exactly like Codex's token_count.
    // Marked cumulative so the server takes the max rather than summing — every
    // poll would otherwise re-add the whole session's tokens.
    events.push(
      wrap(row.time_updated, 'usage.reported', {
        model,
        provider,
        usage: {
          ...emptyUsage(),
          input_tokens: num(row.tokens_input),
          output_tokens: num(row.tokens_output),
          reasoning_output_tokens: num(row.tokens_reasoning),
          cached_input_tokens: num(row.tokens_cache_read),
          cache_creation_input_tokens: num(row.tokens_cache_write),
        },
        cumulative: true,
        // OpenCode settles the real provider bill per session, so this is a
        // REPORTED cost, not our estimate from a rate card.
        ...(row.cost > 0 ? { reported_cost_usd: row.cost } : {}),
      }),
    );

    const endedAt = row.time_archived ?? row.time_compacting;
    if (endedAt) {
      events.push(
        wrap(endedAt, 'session.ended', {
          external_session_id: row.id,
          // The server's `reason` enum is normal|timeout|crash|unknown; what
          // OpenCode actually did rides alongside as an extra key.
          reason: 'normal',
          end_kind: row.time_archived ? 'archived' : 'compacted',
        }),
      );
    }
    return events;
  }

  private partEvents(row: PartRow, accounts: Map<string, AccountIdentity>): NormalizedEvent[] {
    const data = safeJsonParse(row.data);
    if (!data) return [];
    const { provider } = parseModel(row.model);
    const wrap = wrapper(
      row.session_id,
      row.version ?? undefined,
      row.directory,
      account(accounts, provider),
    );
    const type = str(data['type']);

    if (type === 'text') {
      const message = safeJsonParse(row.message_data);
      // Assistant text is the model talking to itself; only a user part is a prompt.
      if (!message || str(message['role']) !== 'user') return [];
      const text = str(data['text']);
      if (!text) return [];
      return [
        wrap(row.time_created, 'user.prompted', {
          prompt_chars: text.length,
          prompt_text: text,
          derived_title: deriveTitle(text),
        }),
      ];
    }

    if (type === 'tool') return toolEvents(data, row.time_created, wrap);
    return [];
  }

  /**
   * Newest session's `version` column — OpenCode stamps its own version on
   * every row. detect() runs every scan cycle; the value changes on upgrade,
   * so a minute-old reading is plenty.
   */
  private latestVersion(): string | undefined {
    if (this.version && Date.now() - this.version.readAt < VERSION_TTL_MS) return this.version.value;
    let value: string | undefined;
    try {
      value =
        this.query<{ version: string | null }>(
          'SELECT version FROM session ORDER BY time_updated DESC LIMIT 1',
        )[0]?.version ?? undefined;
    } catch {
      value = undefined; // absent beats fabricated
    }
    this.version = { readAt: Date.now(), value };
    return value;
  }

  /**
   * One short read-only query on the shared handle.
   *
   * readonly + fileMustExist means a bug here cannot write, migrate or create
   * anything; busy_timeout means a concurrent OpenCode write makes us wait
   * briefly instead of failing, and query_only is the belt to that suspenders.
   * The handle is dropped on any error or when the database path changes, so
   * a rotated or replaced file is picked up on the next call.
   */
  private query<T>(sql: string, ...params: (string | number)[]): T[] {
    const path = resolveDbPath(this.dataDir);
    if (!path) {
      this.disconnect();
      return [];
    }
    if (this.conn && this.conn.path !== path) this.disconnect();
    try {
      if (!this.conn) {
        const db = new Database(path, { readonly: true, fileMustExist: true });
        db.pragma('busy_timeout = 3000');
        db.pragma('query_only = 1');
        this.conn = { path, db, statements: new Map() };
      }
      let statement = this.conn.statements.get(sql);
      if (!statement) {
        statement = this.conn.db.prepare(sql);
        this.conn.statements.set(sql, statement);
      }
      return statement.all(...params) as T[];
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  private disconnect(): void {
    try {
      this.conn?.db.close();
    } catch {
      // Already closed or never opened; nothing to release.
    }
    this.conn = undefined;
  }
}

type Wrap = (
  atMs: number,
  event_type: NormalizedEvent['event']['event_type'],
  payload: Record<string, unknown>,
) => NormalizedEvent;

function account(
  accounts: Map<string, AccountIdentity>,
  provider: string | undefined,
): AccountIdentity | undefined {
  return provider ? accounts.get(provider) : undefined;
}

function wrapper(
  sessionId: string,
  version: string | undefined,
  cwd: string,
  identity: AccountIdentity | undefined,
): Wrap {
  return (atMs, event_type, payload) => ({
    account: identity,
    event: {
      occurred_at: new Date(atMs).toISOString(),
      session_id: sessionId,
      agent: 'opencode',
      agent_version: version,
      event_type,
      payload,
    },
    cwd: cwd || undefined,
    repo: cwd ? { project_path: cwd } : undefined,
  });
}

/** `session.model` is a JSON blob — `{"id":"…","providerID":"…","variant":"…"}`. */
export function parseModel(raw: string | null): { model?: string; provider?: string } {
  if (!raw) return {};
  const parsed = safeJsonParse(raw);
  if (!parsed) return { model: raw }; // older rows may store a bare string
  return { model: str(parsed['id']), provider: str(parsed['providerID']) };
}

/**
 * Events recovered from one `tool` part.
 *
 * The part carries the whole call — status, input, and start/end timestamps —
 * so only the terminal event is emitted, timestamped at the call's START with
 * its real duration. That is what the server's interval merge needs: a separate
 * tool.started would add an event without adding information, and the server
 * already backfills the invocation count from the terminal events.
 *
 * `state.output` is deliberately never read. It is raw command output and file
 * contents, i.e. exactly the code content the privacy pipeline exists to keep
 * off the wire.
 */
export function toolEvents(data: Record<string, unknown>, fallbackMs: number, wrap: Wrap): NormalizedEvent[] {
  const tool = str(data['tool']) ?? 'unknown';
  const state = (data['state'] ?? {}) as Record<string, unknown>;
  const time = (state['time'] ?? {}) as Record<string, unknown>;
  const start = num(time['start']) || fallbackMs;
  const end = num(time['end']);
  const status = str(state['status']);
  // A call still running has no terminal event yet; it will be re-read when the
  // row is updated, because the part cursor tracks time_updated.
  if (status !== 'completed' && status !== 'error') return [];

  const input = (state['input'] ?? {}) as Record<string, unknown>;
  const events: NormalizedEvent[] = [
    wrap(start, status === 'error' ? 'tool.failed' : 'tool.completed', {
      tool_name: tool,
      tool_call_id: str(data['callID']),
      duration_ms: end > start ? end - start : 0,
    }),
  ];

  const command = str(input['command']);
  if (tool === 'bash' && command) events.push(wrap(start, 'command.executed', { command }));

  const path = str(input['filePath']);
  if (!path) return events;

  if (tool === 'read') events.push(wrap(start, 'file.read', { path }));
  else if (tool === 'write' || tool === 'edit') {
    // Same line-counting rules as Claude Code: a line present on both sides of
    // an edit is neither added nor removed. Reused so the two agents' file
    // stats are actually comparable.
    const counts =
      tool === 'write'
        ? countEditLines('Write', { content: input['content'] })
        : countEditLines('Edit', { old_string: input['oldString'], new_string: input['newString'] });
    events.push(
      wrap(start, 'file.changed', { path, change_kind: tool === 'write' ? 'create' : 'edit', ...counts }),
    );
  }
  return events;
}
