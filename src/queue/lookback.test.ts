import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listTranscripts } from '../daemon.js';

/**
 * The regression: listTranscripts defaulted to 7 days at both call sites and
 * nothing could override it, so a first import uploaded the last week and left
 * years of transcripts on disk with no indication anything had been skipped.
 * "Backfill everything" was not expressible.
 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'at-lookback-'));
  mkdirSync(join(root, 'nested'), { recursive: true });
  const day = 86_400_000;
  const write = (rel: string, ageDays: number) => {
    const full = join(root, rel);
    writeFileSync(full, '{}\n');
    const at = (Date.now() - ageDays * day) / 1000;
    utimesSync(full, at, at);
  };
  write('today.jsonl', 0);
  write('six-days.jsonl', 6);
  write('thirty-days.jsonl', 30);
  write('nested/two-years.jsonl', 730);
  return root;
}

describe('listTranscripts lookback', () => {
  it('defaults to the last 7 days', () => {
    const found = listTranscripts(fixture()).map((p) => p.split('/').pop());
    expect(found).toContain('today.jsonl');
    expect(found).toContain('six-days.jsonl');
    expect(found).not.toContain('thirty-days.jsonl');
    expect(found).not.toContain('nested/two-years.jsonl');
  });

  it('widens to whatever it is given, including nested directories', () => {
    const found = listTranscripts(fixture(), 3650).map((p) => p.split('/').pop());
    expect(found).toHaveLength(4);
    expect(found).toContain('thirty-days.jsonl');
    expect(found).toContain('two-years.jsonl');
  });

  it('narrows too', () => {
    const found = listTranscripts(fixture(), 1).map((p) => p.split('/').pop());
    expect(found).toEqual(['today.jsonl']);
  });

  it('returns newest first, so a partial run imports recent work first', () => {
    const found = listTranscripts(fixture(), 3650).map((p) => p.split('/').pop());
    expect(found[0]).toBe('today.jsonl');
    expect(found.at(-1)).toBe('two-years.jsonl');
  });
});
