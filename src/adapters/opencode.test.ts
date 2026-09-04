import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeAdapter, parseModel, resolveDbPath } from './opencode.js';
import { readOpenCodeAccounts, resetAccountCache } from './account.js';
import type { NormalizedEvent, PollContext } from './types.js';
import { addResumedSession, MODEL, seedOpenCodeFixture, T0 } from '../../test/fixtures/opencode-db.js';

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
  seedOpenCodeFixture(dir);
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

    // The server's reason enum has no 'archived'; it goes in end_kind instead.
    expect(byType(events, 'session.ended')[0]?.event.payload).toEqual({
      external_session_id: 'ses_a',
      reason: 'normal',
      end_kind: 'archived',
    });
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
      'opencode:cursor:session_updated',
      'opencode:started:ses_a',
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

  it('starts a resumed session that was created before, but touched after, one already seen', async () => {
    const ctx = pollContext();
    await adapter.poll(ctx); // ses_a seen; its start is now marked
    addResumedSession(dir, T0 + 120_000);
    const events = await adapter.poll(ctx);
    expect(byType(events, 'session.started').map((e) => e.event.session_id)).toEqual(['ses_old']);
    // And only once: the marker, not a created-time cursor, is what gates it.
    expect(byType(await adapter.poll(ctx), 'session.started')).toEqual([]);
  });

  it('parses the model blob, and tolerates a bare string from an older row', () => {
    expect(parseModel(MODEL)).toEqual({ model: 'deepseek/deepseek-v4-pro', provider: 'openrouter' });
    expect(parseModel('gpt-5.6')).toEqual({ model: 'gpt-5.6' });
    expect(parseModel(null)).toEqual({});
  });
});
