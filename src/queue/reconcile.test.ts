import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Spool } from './spool.js';

/**
 * Reconciliation rests on one property: forgetting the checkpoints makes the
 * next scan re-read from byte 0, and re-reading is safe because an event id is
 * derived from (adapter, file, offset, line) and is the server's primary key.
 * These cover the half this repo owns — the forgetting, and what it must not
 * take with it.
 */
describe('Spool.clearCheckpoints', () => {
  let dir: string;
  let spool: Spool;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'at-reconcile-'));
    spool = new Spool(join(dir, 'spool.db'));
  });

  afterEach(() => {
    spool.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('forgets every checkpoint, so the next read starts at zero', () => {
    spool.setCheckpoint('/a.jsonl', '1', 4096, 4096);
    spool.setCheckpoint('/b.jsonl', '2', 128, 128);
    expect(spool.getCheckpoint('/a.jsonl')).not.toBeNull();

    expect(spool.clearCheckpoints()).toBe(2);

    expect(spool.getCheckpoint('/a.jsonl')).toBeNull();
    expect(spool.getCheckpoint('/b.jsonl')).toBeNull();
  });

  it('clears the in-memory cache too, not just the table', () => {
    // The cache is what a scan actually consults; a DELETE that left it
    // populated would report success and change nothing.
    spool.setCheckpoint('/a.jsonl', '1', 4096, 4096);
    spool.clearCheckpoints();
    expect(spool.getCheckpoint('/a.jsonl')).toBeNull();
  });

  it('leaves queued events alone', () => {
    // Events already spooled are still owed to the server. Dropping them here
    // would turn a reconcile into data loss in the exact case it exists for.
    const before = spool.depth();
    spool.clearCheckpoints();
    expect(spool.depth()).toBe(before);
  });

  it('is safe to call when there is nothing to clear', () => {
    expect(spool.clearCheckpoints()).toBe(0);
  });
});
