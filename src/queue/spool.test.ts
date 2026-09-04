import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Spool } from './spool.js';
import { SCHEMA_VERSION, type EventEnvelope } from '../schema.js';

const dirs: string[] = [];
function newSpool() {
  const dir = mkdtempSync(join(tmpdir(), 'agentstrack-'));
  dirs.push(dir);
  return new Spool(join(dir, 'spool.db'));
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const event = (id = randomUUID()): EventEnvelope => ({
  event_id: id,
  schema_version: SCHEMA_VERSION,
  occurred_at: new Date().toISOString(),
  collector_id: '00000000-0000-4000-8000-000000000000',
  session_id: 's1',
  agent: 'claude_code',
  event_type: 'heartbeat',
  payload: {},
});

describe('Spool', () => {
  it('round-trips events and reports depth', () => {
    const spool = newSpool();
    expect(spool.enqueue([event(), event()])).toBe(2);
    expect(spool.depth()).toBe(2);
    expect(spool.peek(10)).toHaveLength(2);
  });

  it('is idempotent on event_id, so a replayed batch does not duplicate', () => {
    const spool = newSpool();
    const e = event();
    expect(spool.enqueue([e])).toBe(1);
    expect(spool.enqueue([e])).toBe(0);
    expect(spool.depth()).toBe(1);
  });

  it('only removes events once acknowledged', () => {
    const spool = newSpool();
    const e = event();
    spool.enqueue([e]);
    spool.ack([e.event_id]);
    expect(spool.depth()).toBe(0);
  });

  it('survives a reopen — the queue is durable across restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentstrack-'));
    dirs.push(dir);
    const path = join(dir, 'spool.db');
    const first = new Spool(path);
    first.enqueue([event(), event()]);
    const id = first.installId();
    first.close();

    const second = new Spool(path);
    expect(second.depth()).toBe(2);
    expect(second.installId()).toBe(id); // stable across restarts
  });

  it('drops an event the server keeps rejecting instead of blocking forever', () => {
    const spool = newSpool();
    const e = event();
    spool.enqueue([e]);
    for (let i = 0; i < 2; i++) expect(spool.fail([e.event_id], 3)).toBe(0);
    expect(spool.fail([e.event_id], 3)).toBe(1);
    expect(spool.depth()).toBe(0);
  });

  it('drains oldest first', () => {
    const spool = newSpool();
    const a = event();
    spool.enqueue([a]);
    const b = event();
    spool.enqueue([b]);
    expect(spool.peek(1)[0]!.eventId).toBe(a.event_id);
  });

  it('stores and updates file checkpoints', () => {
    const spool = newSpool();
    expect(spool.getCheckpoint('/tmp/a.jsonl')).toBeNull();
    spool.setCheckpoint('/tmp/a.jsonl', '123', 500, 900);
    expect(spool.getCheckpoint('/tmp/a.jsonl')).toEqual({ inode: '123', offset: 500, size: 900 });
    spool.setCheckpoint('/tmp/a.jsonl', '123', 900, 900);
    expect(spool.getCheckpoint('/tmp/a.jsonl')!.offset).toBe(900);
  });

  it('discards a corrupt row rather than wedging the queue', () => {
    const spool = newSpool();
    const good = event();
    spool.enqueue([good]);
    // Simulate corruption by writing a bad body directly.
    // @ts-expect-error reaching into the private db is intentional for this test
    spool['db'].prepare('INSERT INTO events (event_id, body, created_at) VALUES (?, ?, ?)').run('bad', '{not json', 0);
    const peeked = spool.peek(10);
    expect(peeked.map((p) => p.eventId)).toEqual([good.event_id]);
    expect(spool.depth()).toBe(1); // the corrupt row was dropped
  });
});

describe('Spool.fail — poison handling must not lose good events', () => {
  it('only ever drops the events in the failing batch', () => {
    // Regression: the delete was table-wide, so an unrelated queued event
    // could be destroyed by another batch exhausting its retries.
    const spool = newSpool();
    const poison = event();
    const innocent = event();
    spool.enqueue([poison, innocent]);
    for (let i = 0; i < 3; i++) spool.fail([poison.event_id], 3);

    expect(spool.depth()).toBe(1);
    expect(spool.peek(10)[0]!.eventId).toBe(innocent.event_id);
  });

  it('rolls the checkpoint cache back with the transaction', () => {
    // Regression: setCheckpoint() updated the in-memory Map before COMMIT, so
    // a failed commit (SQLITE_FULL) left the cache pointing past lines that
    // were never spooled — and the tailer trusted the cache.
    const spool = newSpool();
    spool.setCheckpoint('/t.jsonl', 'ino', 10, 10);
    expect(() =>
      spool.transaction(() => {
        spool.setCheckpoint('/t.jsonl', 'ino', 20, 20);
        throw new Error('SQLITE_FULL');
      }),
    ).toThrow('SQLITE_FULL');
    expect(spool.getCheckpoint('/t.jsonl')).toEqual({ inode: 'ino', offset: 10, size: 10 });
  });

  it('refuses to treat maxAttempts of 0 as "delete everything"', () => {
    // Regression: `attempts >= 0` matched never-attempted rows, so a config of
    // 0 wiped the whole spool on the first network blip.
    const spool = newSpool();
    const e = event();
    spool.enqueue([e]);
    expect(spool.fail([e.event_id], 0)).toBe(1); // this one had its attempt
    expect(spool.depth()).toBe(0);

    const spool2 = newSpool();
    const a = event();
    const b = event();
    spool2.enqueue([a, b]);
    spool2.fail([a.event_id], 0);
    expect(spool2.depth()).toBe(1); // b was never attempted and survives
  });
});
