import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { isExcluded, normalizePath } from './paths.js';

describe('normalizePath — prefixes stop at a path segment', () => {
  it('does not treat a sibling project as inside the root', () => {
    expect(normalizePath('/u/app/src/a.ts', '/u/app', 'relative')).toBe('src/a.ts');
    expect(normalizePath('/u/app', '/u/app', 'relative')).toBe('.');
    expect(normalizePath('/u/app-secret/x/a.ts', '/u/app', 'relative')).toBe('…/x/a.ts');
  });

  it('does not treat a longer username as inside home', () => {
    // /Users/x vs /Users/xavier, against whatever home this machine has.
    const home = homedir();
    expect(normalizePath(`${home}/notes/a.md`, undefined, 'relative')).toBe('~/notes/a.md');
    expect(normalizePath(`${home}ier/secret/a.md`, undefined, 'relative')).toBe('…/secret/a.md');
  });
});

describe('trailing slashes', () => {
  it('trims them in linear time', () => {
    const slashes = '/'.repeat(100_000) + 'x';
    const started = performance.now();
    isExcluded(slashes, [slashes]);
    normalizePath(slashes, slashes, 'relative');
    expect(performance.now() - started).toBeLessThan(200);
    expect(isExcluded('/u/app/', ['/u/app//'])).toBe(true);
  });
});
