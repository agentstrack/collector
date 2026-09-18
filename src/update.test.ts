import { describe, expect, it } from 'vitest';
import { compareVersions, selfUpdatable } from './update.js';

describe('compareVersions', () => {
  it('orders releases', () => {
    expect(compareVersions('0.4.2', '0.4.1')).toBeGreaterThan(0);
    expect(compareVersions('0.4.1', '0.4.2')).toBeLessThan(0);
    expect(compareVersions('0.4.2', '0.4.2')).toBe(0);
    expect(compareVersions('0.5.0', '0.4.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
  });

  it('does not treat 10 as older than 9 (string compare would)', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('0.4.10', '0.4.9')).toBeGreaterThan(0);
  });

  it('sorts a prerelease before the release it precedes', () => {
    // An unattended updater must never walk onto an rc on its own.
    expect(compareVersions('0.5.0-rc.1', '0.5.0')).toBeLessThan(0);
    expect(compareVersions('0.5.0', '0.5.0-rc.1')).toBeGreaterThan(0);
  });
});

describe('selfUpdatable', () => {
  it('allows a global npm install', () => {
    const p = '/Users/x/.nvm/versions/node/v22.22.0/lib/node_modules/@agentstrack/collector/dist/daemon.js';
    expect(selfUpdatable(p).ok).toBe(true);
  });

  it('refuses a source checkout', () => {
    // `npm i -g` here would overwrite the tree someone is editing. The launchd
    // unit pointed straight at a working copy in the field, so this is a real
    // shape, not a hypothetical one.
    const p = '/Users/x/Web/ddcode/agentstrack-collector/dist/daemon.js';
    const result = selfUpdatable(p);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/checkout/);
  });

  it('refuses some other package that happens to live in node_modules', () => {
    expect(selfUpdatable('/usr/lib/node_modules/something-else/dist/daemon.js').ok).toBe(false);
  });
});
