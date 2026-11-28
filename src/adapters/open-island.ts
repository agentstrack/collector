import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { RateWindow } from './codex.js';

/**
 * Claude Code's 5-hour and 7-day plan windows, read from the file Open Island
 * (a separate macOS app) writes from Claude's status line. Opt-in only:
 * `tracking.open_island_rate_limits: true`.
 *
 * Shape (interface fact, not code): {"five_hour":{"used_percentage":29,
 * "resets_at":<epoch s>},"seven_day":{…}}.
 *
 * The file sits in a world-writable /tmp, so it is treated as untrusted and
 * advisory: refused if it is a symlink, not a regular file, not owned by this
 * user or larger than any honest version of it; only clamped numbers come
 * out. It names no account either — with several CLAUDE_CONFIG_DIR profiles
 * it describes whichever one last ran its status line. Never throws, never
 * logs what it read.
 */
export const OPEN_ISLAND_RL_PATH = '/tmp/open-island-rl.json';
const MAX_BYTES = 4096;

const WINDOWS: [key: string, minutes: number][] = [
  ['five_hour', 300],
  ['seven_day', 10_080],
];

export interface OpenIslandReading {
  windows: RateWindow[];
  mtimeMs: number;
}

export function readOpenIslandRateLimits(
  path = OPEN_ISLAND_RL_PATH,
  uid = process.getuid?.(),
): OpenIslandReading | undefined {
  let fd: number | undefined;
  try {
    // O_NOFOLLOW refuses a symlink at open; every other check runs on the open
    // descriptor, so there is no check-then-open window to race.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
    if (uid !== undefined && stat.uid !== uid) return undefined;

    const buffer = Buffer.alloc(MAX_BYTES);
    const read = readSync(fd, buffer, 0, MAX_BYTES, 0);
    const raw: unknown = JSON.parse(buffer.toString('utf8', 0, read));
    if (!raw || typeof raw !== 'object') return undefined;

    const windows: RateWindow[] = [];
    for (const [key, minutes] of WINDOWS) {
      const w = (raw as Record<string, unknown>)[key];
      if (!w || typeof w !== 'object') continue;
      const used = (w as Record<string, unknown>)['used_percentage'];
      if (typeof used !== 'number' || !Number.isFinite(used)) continue;
      const resets = (w as Record<string, unknown>)['resets_at'];
      windows.push({
        window_minutes: minutes,
        used_percent: Math.min(100, Math.max(0, used)),
        ...(typeof resets === 'number' && resets > 0 && resets < 1e11
          ? { resets_at: new Date(resets * 1000).toISOString() }
          : {}),
      });
    }
    return windows.length ? { windows, mtimeMs: stat.mtimeMs } : undefined;
  } catch {
    return undefined; // absent, unreadable, or not JSON: nothing to report
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
