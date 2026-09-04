import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Spool } from './spool.js';

/**
 * Resumable line tailer.
 *
 * Reads in fixed-size chunks and hands every complete line to `onLines`; the
 * checkpoint (path, inode, offset) for a chunk is written in the SAME
 * transaction as whatever `onLines` spooled, so a throw or a crash between
 * "read" and "queued" re-reads those lines instead of losing them. Failure
 * modes it must survive:
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
 *  - a pathological line: anything over `maxLineBytes` is skipped to the next
 *    newline and counted, never buffered — one 512MiB line used to throw and
 *    abort every later file on every scan.
 *  - a huge backlog: at most `maxBytesPerScan` per file per call, so a first
 *    import yields to the upload loop instead of reading 27MB files back to
 *    back.
 *
 * Offsets are byte offsets, computed from the buffer rather than from decoded
 * strings — a multi-byte character would otherwise desynchronise the position.
 */
export interface TailedLine {
  text: string;
  /** Byte offset of the line's first byte. Stable for an append-only file. */
  offset: number;
}

export interface TailResult {
  lines: number;
  bytesRead: number;
  /** Lines over `maxLineBytes`, discarded. */
  skipped: number;
  /** True when `maxBytesPerScan` stopped the read before EOF. */
  more: boolean;
}

export interface TailOptions {
  chunkBytes?: number;
  maxLineBytes?: number;
  maxBytesPerScan?: number;
}

const NEWLINE = 0x0a;
const CR = 0x0d;
const EMPTY = Buffer.alloc(0);

export async function tailFile(
  path: string,
  spool: Spool,
  onLines: (lines: TailedLine[]) => void,
  options: TailOptions = {},
): Promise<TailResult> {
  const chunkBytes = options.chunkBytes ?? 4 * 1024 * 1024;
  const maxLineBytes = options.maxLineBytes ?? 8 * 1024 * 1024;
  const maxBytesPerScan = options.maxBytesPerScan ?? 64 * 1024 * 1024;
  const result: TailResult = { lines: 0, bytesRead: 0, skipped: 0, more: false };

  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats) return result;
  const inode = String(stats.ino);
  const checkpoint = spool.getCheckpoint(path);

  let start = 0;
  if (checkpoint && checkpoint.inode === inode && checkpoint.offset <= stats.size) {
    start = checkpoint.offset;
  }
  // else: rotated (inode differs) or truncated (offset > size) — reread from 0.

  if (start >= stats.size) {
    spool.setCheckpoint(path, inode, stats.size, stats.size);
    return result;
  }

  const handle = await open(path, 'r');
  try {
    let position = start;
    let carry = EMPTY;
    // Inside a line that already exceeded maxLineBytes: drop bytes up to and
    // including the next newline.
    let skipping = false;

    while (position < stats.size && result.bytesRead < maxBytesPerScan) {
      const want = Math.min(chunkBytes, stats.size - position);
      const chunk = Buffer.allocUnsafe(want);
      let got = 0;
      // read() may return short; loop until the chunk is full or the file
      // turned out shorter than stat said (truncated under us).
      while (got < want) {
        const { bytesRead } = await handle.read(chunk, got, want - got, position + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      if (got === 0) break;
      result.bytesRead += got;

      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, got)]) : chunk.subarray(0, got);
      const dataStart = position - carry.length;
      position += got;

      const lastNewline = data.lastIndexOf(NEWLINE);
      if (lastNewline === -1) {
        // No complete line in what we have. Either keep waiting for the
        // newline or, past the cap, give up on this line entirely.
        if (skipping || data.length > maxLineBytes) {
          if (!skipping) result.skipped += 1;
          skipping = true;
          carry = EMPTY;
          spool.setCheckpoint(path, inode, position, stats.size);
        } else {
          carry = Buffer.from(data);
        }
        continue;
      }

      const lines: TailedLine[] = [];
      let lineStart = 0;
      while (lineStart <= lastNewline) {
        const nl = data.indexOf(NEWLINE, lineStart);
        const end = nl > lineStart && data[nl - 1] === CR ? nl - 1 : nl;
        if (skipping) {
          skipping = false; // this newline terminates the oversized line
        } else if (nl - lineStart > maxLineBytes) {
          result.skipped += 1;
        } else if (end > lineStart) {
          lines.push({ text: data.toString('utf8', lineStart, end), offset: dataStart + lineStart });
        }
        lineStart = nl + 1;
      }

      const consumed = dataStart + lastNewline + 1;
      // Lines and their checkpoint commit together, or not at all.
      spool.transaction(() => {
        if (lines.length > 0) onLines(lines);
        spool.setCheckpoint(path, inode, consumed, stats.size);
      });
      result.lines += lines.length;

      const rest = data.subarray(lastNewline + 1);
      if (rest.length > maxLineBytes) {
        result.skipped += 1;
        skipping = true;
        carry = EMPTY;
        spool.setCheckpoint(path, inode, position, stats.size);
      } else {
        // Copy, so the 4MB chunk behind the slice can be collected.
        carry = rest.length ? Buffer.from(rest) : EMPTY;
      }
    }
    result.more = position < stats.size;
  } finally {
    await handle.close();
  }
  return result;
}
