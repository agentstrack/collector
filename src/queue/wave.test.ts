import { describe, expect, it } from 'vitest';
import { chunkWave } from '../daemon.js';

/**
 * The two properties that make concurrent uploads safe, expressed on the
 * chunking itself. Both were regressions waiting to happen when flush() went
 * from one batch at a time to a wave:
 *
 *  1. ONE peek per wave. Peeking per batch hands the same rows to every
 *     request, because nothing is acked until they return — the same events
 *     would upload `concurrency` times.
 *  2. Every spooled event lands in exactly one batch. An off-by-one in the
 *     slice silently drops telemetry that has already been dequeued.
 */
const chunk = chunkWave;

const wave = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('upload wave chunking', () => {
  it('splits a full wave into exactly `concurrency` batches', () => {
    expect(chunk(wave(400), 100)).toHaveLength(4);
  });

  it('covers every event exactly once, with no duplicates', () => {
    const flat = chunk(wave(400), 100).flat();
    expect(flat).toEqual(wave(400));
    expect(new Set(flat).size).toBe(400);
  });

  it('handles a partial final batch', () => {
    const batches = chunk(wave(250), 100);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toHaveLength(250);
  });

  it('produces one batch when the wave is short', () => {
    expect(chunk(wave(7), 100).map((b) => b.length)).toEqual([7]);
  });

  it('produces nothing for an empty spool', () => {
    expect(chunk(wave(0), 100)).toEqual([]);
  });

  it('survives a batch size of 1 without losing events', () => {
    // batchSize shrinks to 1 after repeated 413s; the wave must still be sound.
    expect(chunk(wave(5), 1).flat()).toEqual(wave(5));
  });
});
