import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Spool } from './spool.js';
import { tailFile, type TailOptions } from './tailer.js';

/** Collects every emitted line, the way the daemon does per chunk. */
async function read(file: string, spool: Spool, options?: TailOptions) {
  const lines: string[] = [];
  const result = await tailFile(file, spool, (chunk) => lines.push(...chunk.map((l) => l.text)), options);
  return { lines, result };
}

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
    expect((await read(file, spool)).lines).toEqual(['a', 'b']);
    expect((await read(file, spool)).lines).toEqual([]);
  });

  it('resumes mid-file after a restart, without replaying', async () => {
    const { spool, file } = setup();
    writeFileSync(file, 'first\n');
    await read(file, spool);

    appendFileSync(file, 'second\nthird\n');
    expect((await read(file, spool)).lines).toEqual(['second', 'third']);
  });

  it('rereads from the start when the file is replaced (inode changes)', async () => {
    const { spool, file } = setup();
    writeFileSync(file, 'old-a\nold-b\n');
    await read(file, spool);

    // Rotation: delete and recreate gives a new inode.
    unlinkSync(file);
    writeFileSync(file, 'new-a\n');
    expect((await read(file, spool)).lines).toEqual(['new-a']);
  });

  it('rereads from the start when the file is truncated', async () => {
    const { spool, file } = setup();
    writeFileSync(file, 'aaaa\nbbbb\ncccc\n');
    await read(file, spool);

    writeFileSync(file, 'x\n'); // same inode, now much smaller
    expect((await read(file, spool)).lines).toEqual(['x']);
  });

  it('returns empty for a file that does not exist', async () => {
    const { spool, dir } = setup();
    expect((await read(join(dir, 'nope.jsonl'), spool)).lines).toEqual([]);
  });

  it('handles a large file without losing lines across passes', async () => {
    const { spool, file } = setup();
    const first = Array.from({ length: 500 }, (_, i) => `line-${i}`).join('\n') + '\n';
    writeFileSync(file, first);
    const a = await read(file, spool);
    expect(a.lines).toHaveLength(500);

    appendFileSync(file, Array.from({ length: 250 }, (_, i) => `more-${i}`).join('\n') + '\n');
    const b = await read(file, spool);
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
    expect((await read(file, spool)).lines).toEqual(['{"a":1}']);

    appendFileSync(file, '}\n');
    expect((await read(file, spool)).lines).toEqual(['{"b":2}']);
  });

  it('emits nothing at all when no complete line exists yet', async () => {
    const { spool, file } = setup();
    writeFileSync(file, '{"partial":');
    expect((await read(file, spool)).lines).toEqual([]);
    appendFileSync(file, '1}\n');
    expect((await read(file, spool)).lines).toEqual(['{"partial":1}']);
  });

  it('tolerates CRLF line endings', async () => {
    const { spool, file } = setup();
    writeFileSync(file, 'a\r\nb\r\n');
    expect((await read(file, spool)).lines).toEqual(['a', 'b']);
  });

  it('handles multi-byte characters without corrupting the offset', async () => {
    const { spool, file } = setup();
    writeFileSync(file, '{"t":"héllo → 世界"}\n');
    expect((await read(file, spool)).lines).toHaveLength(1);
    appendFileSync(file, '{"t":"next"}\n');
    const second = await read(file, spool);
    expect(second.lines).toEqual(['{"t":"next"}']);
  });

  it('streams in chunks, carrying a line split across the boundary, with byte offsets', async () => {
    const { spool, file } = setup();
    // 10 lines of 12 bytes; 16-byte chunks cut every line somewhere.
    const text = Array.from({ length: 10 }, (_, i) => `{"n":${String(i).padStart(5, '0')}}`).join('\n') + '\n';
    writeFileSync(file, text + '{"partial":');
    const offsets: number[] = [];
    const lines: string[] = [];
    const result = await tailFile(
      file,
      spool,
      (chunk) => chunk.forEach((l) => { lines.push(l.text); offsets.push(l.offset); }),
      { chunkBytes: 16 },
    );
    expect(lines).toHaveLength(10);
    expect(lines[7]).toBe('{"n":00007}');
    expect(offsets).toEqual(Array.from({ length: 10 }, (_, i) => i * 12));
    expect(result.bytesRead).toBe(text.length + '{"partial":'.length);
    expect(spool.getCheckpoint(file)!.offset).toBe(text.length); // partial line not consumed
  });

  it('skips a line over maxLineBytes, resumes after it, and bounds bytes per scan', async () => {
    const { spool, file } = setup();
    writeFileSync(file, 'ok-1\n' + 'x'.repeat(50) + '\nok-2\nok-3\n');
    const first = await read(file, spool, { chunkBytes: 8, maxLineBytes: 20, maxBytesPerScan: 56 });
    expect(first.lines).toEqual(['ok-1']);
    expect(first.result.skipped).toBe(1);
    expect(first.result.more).toBe(true);
    const second = await read(file, spool, { chunkBytes: 8, maxLineBytes: 20 });
    expect(second.lines).toEqual(['ok-2', 'ok-3']);
    expect(second.result.more).toBe(false);
  });

  it('does not advance the checkpoint when the consumer throws — the lines are re-read', async () => {
    // Regression: the checkpoint used to be written before the events were
    // spooled, so a throw between the two lost those lines forever.
    const { spool, file } = setup();
    writeFileSync(file, 'a\nb\n');
    await expect(
      tailFile(file, spool, () => {
        throw new Error('SQLITE_FULL');
      }),
    ).rejects.toThrow('SQLITE_FULL');
    expect(spool.getCheckpoint(file)).toBeNull();
    expect((await read(file, spool)).lines).toEqual(['a', 'b']);
    expect(spool.getCheckpoint(file)!.offset).toBe(4);
  });
});
