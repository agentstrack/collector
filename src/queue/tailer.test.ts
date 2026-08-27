import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Spool } from './spool.js';
import { tailFile } from './tailer.js';

const dirs: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agentstrack-tail-'));
  dirs.push(dir);
  return { dir, spool: new Spool(join(dir, 'spool.db')), file: join(dir, 'log.jsonl') };
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('tailFile', () => {
  it('reads a file once, then returns nothing until it grows', async () => {
    const { spool, file } = setup();
    writeFileSync(file, 'a\nb\n');
    expect((await tailFile(file, spool)).lines).toEqual(['a', 'b']);
    expect((await tailFile(file, spool)).lines).toEqual([]);
  });

  it('resumes mid-file after a restart, without replaying', async () => {
    const { spool, file } = setup();
    writeFileSync(file, 'first\n');
    await tailFile(file, spool);

    appendFileSync(file, 'second\nthird\n');
    expect((await tailFile(file, spool)).lines).toEqual(['second', 'third']);
  });

  it('rereads from the start when the file is replaced (inode changes)', async () => {
    const { spool, file } = setup();
    writeFileSync(file, 'old-a\nold-b\n');
    await tailFile(file, spool);

    // Rotation: delete and recreate gives a new inode.
    unlinkSync(file);
    writeFileSync(file, 'new-a\n');
    expect((await tailFile(file, spool)).lines).toEqual(['new-a']);
  });

  it('rereads from the start when the file is truncated', async () => {
    const { spool, file } = setup();
    writeFileSync(file, 'aaaa\nbbbb\ncccc\n');
    await tailFile(file, spool);

    writeFileSync(file, 'x\n'); // same inode, now much smaller
    expect((await tailFile(file, spool)).lines).toEqual(['x']);
  });

  it('returns empty for a file that does not exist', async () => {
    const { spool, dir } = setup();
    expect((await tailFile(join(dir, 'nope.jsonl'), spool)).lines).toEqual([]);
  });

  it('handles a large file without losing lines across passes', async () => {
    const { spool, file } = setup();
    const first = Array.from({ length: 500 }, (_, i) => `line-${i}`).join('\n') + '\n';
    writeFileSync(file, first);
    const a = await tailFile(file, spool);
    expect(a.lines).toHaveLength(500);

    appendFileSync(file, Array.from({ length: 250 }, (_, i) => `more-${i}`).join('\n') + '\n');
    const b = await tailFile(file, spool);
    expect(b.lines).toHaveLength(250);
    expect(b.lines[0]).toBe('more-0');
  });

  it('never emits a partial trailing line — the agent is still writing it', async () => {
    // Regression: the checkpoint used to jump to EOF over an unterminated line,
    // so the line was emitted broken AND its remainder arrived orphaned on the
    // next pass. Both halves failed to parse and the event was lost forever.
    // Every live agent session hits this on the line being written right now.
    const { spool, file } = setup();
    writeFileSync(file, '{"a":1}\n{"b":2');
    expect((await tailFile(file, spool)).lines).toEqual(['{"a":1}']);

    appendFileSync(file, '}\n');
    expect((await tailFile(file, spool)).lines).toEqual(['{"b":2}']);
  });

  it('emits nothing at all when no complete line exists yet', async () => {
    const { spool, file } = setup();
    writeFileSync(file, '{"partial":');
    expect((await tailFile(file, spool)).lines).toEqual([]);
    appendFileSync(file, '1}\n');
    expect((await tailFile(file, spool)).lines).toEqual(['{"partial":1}']);
  });

  it('tolerates CRLF line endings', async () => {
    const { spool, file } = setup();
    writeFileSync(file, 'a\r\nb\r\n');
    expect((await tailFile(file, spool)).lines).toEqual(['a', 'b']);
  });

  it('handles multi-byte characters without corrupting the offset', async () => {
    const { spool, file } = setup();
    writeFileSync(file, '{"t":"héllo → 世界"}\n');
    expect((await tailFile(file, spool)).lines).toHaveLength(1);
    appendFileSync(file, '{"t":"next"}\n');
    const second = await tailFile(file, spool);
    expect(second.lines).toEqual(['{"t":"next"}']);
  });
});
