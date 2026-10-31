import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOpenIslandRateLimits } from './open-island.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function file(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentstrack-oi-'));
  dirs.push(dir);
  const path = join(dir, 'open-island-rl.json');
  writeFileSync(path, content);
  return path;
}

const REAL = '{"five_hour":{"used_percentage":29,"resets_at":1793490600},"seven_day":{"used_percentage":124,"resets_at":1793854800}}';

describe('readOpenIslandRateLimits', () => {
  it('maps five_hour/seven_day to 300/10080-minute windows, clamped to 0..100', () => {
    expect(readOpenIslandRateLimits(file(REAL))?.windows).toEqual([
      { window_minutes: 300, used_percent: 29, resets_at: new Date(1793490600_000).toISOString() },
      { window_minutes: 10080, used_percent: 100, resets_at: new Date(1793854800_000).toISOString() },
    ]);
  });

  it('refuses a symlink, a file owned by someone else, an oversized file and garbage', () => {
    const real = file(REAL);
    const link = join(dirs[0]!, 'link.json');
    symlinkSync(real, link);
    expect(readOpenIslandRateLimits(link)).toBeUndefined();
    expect(readOpenIslandRateLimits(real, (process.getuid?.() ?? 0) + 1)).toBeUndefined();
    expect(readOpenIslandRateLimits(file(`{"pad":"${'x'.repeat(5000)}"}`))).toBeUndefined();
    expect(readOpenIslandRateLimits(file('not json'))).toBeUndefined();
    expect(readOpenIslandRateLimits(file('{"five_hour":{"used_percentage":"29"}}'))).toBeUndefined();
    expect(readOpenIslandRateLimits(join(dirs[0]!, 'missing.json'))).toBeUndefined();
  });
});
