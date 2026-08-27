import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeAdapter, parseModel, resolveDbPath } from './opencode.js';
import { readOpenCodeAccounts, resetAccountCache } from './account.js';
import type { NormalizedEvent, PollContext } from './types.js';

/**
 * A miniature copy of OpenCode 1.18's real schema — the column list is what
 * the adapter's SQL is written against, so a drift here is a drift there.
 */
const SCHEMA = `
CREATE TABLE session (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
  directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT,
  summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  time_compacting INTEGER, time_archived INTEGER,
  workspace_id TEXT, path TEXT, agent TEXT, model TEXT,
  cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL,
  tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
  tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
  metadata TEXT
);
CREATE TABLE message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE TABLE part (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
`;

const T0 = Date.now() - 3600_000;
const MODEL = '{"id":"deepseek/deepseek-v4-pro","providerID":"openrouter","variant":"default"}';

let dir: string;
let adapter: OpenCodeAdapter;

/** In-memory stand-in for the spool's meta store. */
function pollContext(): PollContext & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    collectorId: '00000000-0000-4000-8000-000000000000',
    getMeta: (k) => store.get(k) ?? null,
    setMeta: (k, v) => void store.set(k, v),
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentstrack-opencode-'));
  const db = new Database(join(dir, 'opencode.db'));
  db.exec(SCHEMA);
  db.prepare(
    `INSERT INTO session (id, project_id, slug, directory, title, version, agent, model, cost,
       tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
       time_created, time_updated, time_archived)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'ses_a', 'prj', 'slug', '/Users/dev/proj', 'Fix the cost calculator', '1.18.21', 'build',
    MODEL, 1.2345, 100965, 25243, 13765, 16120260, 264711, T0, T0 + 60_000, T0 + 60_000,
  );
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)').run(
    'msg_u', 'ses_a', T0 + 1000, T0 + 1000, JSON.stringify({ role: 'user' }),
  );
  const part = db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)',
  );
  part.run('prt_t', 'msg_u', 'ses_a', T0 + 1000, T0 + 1000, JSON.stringify({ type: 'text', text: 'fix the cost calculator please' }));
  part.run('prt_bash', 'msg_u', 'ses_a', T0 + 2000, T0 + 2000, JSON.stringify({
    type: 'tool', tool: 'bash', callID: 'call_1',
    state: { status: 'completed', input: { command: 'pnpm test' }, output: 'SECRET OUTPUT', time: { start: T0 + 2000, end: T0 + 2500 } },
  }));
  part.run('prt_edit', 'msg_u', 'ses_a', T0 + 3000, T0 + 3000, JSON.stringify({
    type: 'tool', tool: 'edit', callID: 'call_2',
    state: { status: 'completed', time: { start: T0 + 3000, end: T0 + 3100 },
      input: { filePath: '/Users/dev/proj/a.ts', oldString: 'a\nb', newString: 'a\nc\nd' } },
  }));
  part.run('prt_fail', 'msg_u', 'ses_a', T0 + 4000, T0 + 4000, JSON.stringify({
    type: 'tool', tool: 'grep', callID: 'call_3', state: { status: 'error', time: { start: T0 + 4000, end: T0 + 4001 } },
  }));
  part.run('prt_running', 'msg_u', 'ses_a', T0 + 5000, T0 + 5000, JSON.stringify({
    type: 'tool', tool: 'bash', callID: 'call_4', state: { status: 'running', input: { command: 'sleep 9' } },
  }));
  db.close();

  writeFileSync(
    join(dir, 'account.json'),
    JSON.stringify({
      version: 2,
      accounts: { acc1: { id: 'acc1', serviceID: 'openrouter', description: 'default', credential: 'sk-live-DO-NOT-READ' } },
      active: { openrouter: 'acc1' },
    }),
  );
  resetAccountCache();
  adapter = new OpenCodeAdapter(dir);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const byType = (events: NormalizedEvent[], type: string) =>
  events.filter((e) => e.event.event_type === type);

describe('OpenCodeAdapter', () => {
  it('detects the database and reports the version OpenCode stamped on the row', async () => {
    const detection = await adapter.detect();
    expect(detection.installed).toBe(true);
    expect(detection.version).toBe('1.18.21');
    // Nothing for the tailer: a .db is not a log.
    expect(detection.watchPaths).toEqual([]);
  });

  it('normalize() is inert — this adapter has no lines', () => {
    for (const bad of ['', 'not json', '{"type":"tool"}']) {
      expect(adapter.normalize(bad, { collectorId: 'c', sourceFile: 'f' })).toEqual([]);
    }
  });

  it('emits session start, cumulative usage with the REPORTED cost, and the end', async () => {
    const events = await adapter.poll(pollContext());

    const started = byType(events, 'session.started')[0];
    expect(started?.event.session_id).toBe('ses_a');
    expect(started?.event.agent).toBe('opencode');
    expect(started?.event.agent_version).toBe('1.18.21');
    expect(started?.event.payload['external_session_id']).toBe('ses_a');
    expect(started?.event.payload['derived_title']).toBe('Fix the cost calculator');
    expect(started?.cwd).toBe('/Users/dev/proj');

    const usage = byType(events, 'usage.reported')[0];
    // Running totals, exactly like Codex: the server must gauge, not sum.
    expect(usage?.event.payload['cumulative']).toBe(true);
    expect(usage?.event.payload['model']).toBe('deepseek/deepseek-v4-pro');
    expect(usage?.event.payload['usage']).toEqual({
      input_tokens: 100965,
      output_tokens: 25243,
      reasoning_output_tokens: 13765,
      cached_input_tokens: 16120260,
      cache_creation_input_tokens: 264711,
    });
    // OpenCode settles the real bill, so this must land as REPORTED, not an estimate.
    expect(usage?.event.payload['reported_cost_usd']).toBe(1.2345);

    expect(byType(events, 'session.ended')[0]?.event.payload['reason']).toBe('archived');
  });

  it('recovers prompts, tools, commands and file changes from message/part', async () => {
    const events = await adapter.poll(pollContext());

    const prompt = byType(events, 'user.prompted')[0];
    expect(prompt?.event.payload['prompt_chars']).toBe('fix the cost calculator please'.length);
    expect(prompt?.event.payload['derived_title']).toBeTruthy();

    expect(byType(events, 'command.executed')[0]?.event.payload['command']).toBe('pnpm test');
    expect(byType(events, 'tool.failed')[0]?.event.payload['tool_name']).toBe('grep');

    const bash = byType(events, 'tool.completed').find((e) => e.event.payload['tool_name'] === 'bash');
    expect(bash?.event.payload['duration_ms']).toBe(500);
    // Timestamped at the call's START so the server's interval merge sees the
    // real working window, not just the moment it finished.
    expect(Date.parse(bash!.event.occurred_at)).toBe(T0 + 2000);

    const changed = byType(events, 'file.changed')[0];
    expect(changed?.event.payload['path']).toBe('/Users/dev/proj/a.ts');
    // 'a' survives the edit; 'b' goes, 'c' and 'd' arrive.
    expect(changed?.event.payload).toMatchObject({ lines_added: 2, lines_removed: 1 });

    // A call still running has no outcome yet and must not be reported as one.
    expect(events.every((e) => e.event.payload['tool_call_id'] !== 'call_4')).toBe(true);
    // Tool output is command output and file contents; it must never travel.
    expect(JSON.stringify(events)).not.toContain('SECRET OUTPUT');
  });

  it('attaches the provider account without ever reading the credential', async () => {
    const events = await adapter.poll(pollContext());
    for (const type of ['session.started', 'user.prompted']) {
      expect(byType(events, type)[0]?.account, type).toEqual({
        key: 'openrouter:acc1',
        label: 'default',
        provider: 'openrouter',
      });
    }
    expect(JSON.stringify(events)).not.toContain('sk-live');
    expect(JSON.stringify([...readOpenCodeAccounts(dir)])).not.toContain('sk-live');
  });

  it('resumes from its cursors instead of re-emitting the whole database', async () => {
    const ctx = pollContext();
    const first = await adapter.poll(ctx);
    expect(first.length).toBeGreaterThan(0);
    expect(await adapter.poll(ctx)).toEqual([]);
    expect([...ctx.store.keys()].sort()).toEqual([
      'opencode:cursor:part_updated',
      'opencode:cursor:session_created',
      'opencode:cursor:session_updated',
    ]);
  });

  it('never writes to the live database', async () => {
    const path = join(dir, 'opencode.db');
    const before = statSync(path).mtimeMs;
    await adapter.poll(pollContext());
    await adapter.health();
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it('resolves the database path the way OpenCode does', () => {
    expect(resolveDbPath(dir)).toBe(join(dir, 'opencode.db'));
    expect(resolveDbPath(join(dir, 'nope'))).toBeUndefined();

    process.env['OPENCODE_DB'] = 'opencode.db';
    try {
      expect(resolveDbPath(dir)).toBe(join(dir, 'opencode.db'));
    } finally {
      delete process.env['OPENCODE_DB'];
    }
  });

  it('parses the model blob, and tolerates a bare string from an older row', () => {
    expect(parseModel(MODEL)).toEqual({ model: 'deepseek/deepseek-v4-pro', provider: 'openrouter' });
    expect(parseModel('gpt-5.6')).toEqual({ model: 'gpt-5.6' });
    expect(parseModel(null)).toEqual({});
  });
});
