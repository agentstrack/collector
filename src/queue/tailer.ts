import { existsSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Spool } from './spool.js';

/**
 * Resumable line tailer.
 *
 * Checkpoints (path, inode, offset) after every read so a restart continues
 * exactly where it stopped. Three failure modes it must survive:
 *
 *  - rotation/replacement: the inode changes, so the old offset is meaningless
 *    and we start from zero.
 *  - truncation: the file is smaller than our offset, so the offset is past
 *    the end and we start from zero.
 *  - a partial trailing line: the agent is mid-write. We must NOT consume it —
 *    emitting half a JSON object loses that event permanently, because the
 *    remainder arrives on the next pass as an orphaned fragment and both
 *    halves fail to parse. So the checkpoint stops at the last complete
 *    newline and the partial line is re-read whole next time.
 *
 * Offsets are byte offsets, computed from the buffer rather than from decoded
 * strings — a multi-byte character would otherwise desynchronise the position.
 */
export interface TailResult {
  lines: string[];
  bytesRead: number;
}

const NEWLINE = 0x0a;

export async function tailFile(path: string, spool: Spool): Promise<TailResult> {
  if (!existsSync(path)) return { lines: [], bytesRead: 0 };

  const stats = statSync(path);
  const inode = String(stats.ino);
  const checkpoint = spool.getCheckpoint(path);

  let start = 0;
  if (checkpoint && checkpoint.inode === inode && checkpoint.offset <= stats.size) {
    start = checkpoint.offset;
  }
  // else: rotated (inode differs) or truncated (offset > size) — reread from 0.

  if (start >= stats.size) {
    spool.setCheckpoint(path, inode, stats.size, stats.size);
    return { lines: [], bytesRead: 0 };
  }

  const length = stats.size - start;
  const buffer = Buffer.allocUnsafe(length);

  const handle = await open(path, 'r');
  try {
    await handle.read(buffer, 0, length, start);
  } finally {
    await handle.close();
  }

  // Consume only up to the final newline. Anything after it is a line the
  // agent has not finished writing.
  const lastNewline = buffer.lastIndexOf(NEWLINE);
  if (lastNewline === -1) {
    // No complete line yet — leave the checkpoint untouched so the whole
    // partial line is re-read once it is terminated.
    return { lines: [], bytesRead: 0 };
  }

  const consumable = buffer.subarray(0, lastNewline + 1);
  const lines = consumable
    .toString('utf8')
    .split('\n')
    // The trailing element after the final \n is always '' — drop it, and drop
    // any blank lines rather than handing '' to a parser.
    .filter((line) => line.length > 0)
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));

  const consumed = start + consumable.length;
  spool.setCheckpoint(path, inode, consumed, stats.size);
  return { lines, bytesRead: consumable.length };
}
