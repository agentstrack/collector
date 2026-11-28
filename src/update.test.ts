import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { compareVersions, installArgs, installVersion, isReleaseVersion, npmEnv, npmRunOptions, selfUpdatable } from './update.js';

describe('isReleaseVersion — the registry answer becomes an npm argument', () => {
  it('accepts plain x.y.z only', () => {
    expect(isReleaseVersion('0.7.0')).toBe(true);
    expect(isReleaseVersion('10.20.30')).toBe(true);
    for (const bad of ['0.7.0-rc.1', 'latest', '^0.7.0', '--prefix=/tmp', 'git+https://x/y.git', '0.7', ' 0.7.0', '0.7.0\n', 7, undefined]) {
      expect(isReleaseVersion(bad), String(bad)).toBe(false);
    }
  });

  it('installVersion refuses before running npm', async () => {
    await expect(installVersion('1.0.0 --registry=https://evil.example')).rejects.toThrow(/x\.y\.z/);
  });

  it('pins the registry for the package and its scope', () => {
    expect(installArgs('0.7.0')).toEqual(
      expect.arrayContaining([
        '@agentstrack/collector@0.7.0',
        '--registry=https://registry.npmjs.org',
        '--@agentstrack:registry=https://registry.npmjs.org',
      ]),
    );
    expect(installArgs('0.7.0')).not.toContain('--ignore-scripts');
  });

  it("runs npm from the temp dir, so the user's project .npmrc is never read", () => {
    const options = npmRunOptions(1234);
    expect(options.cwd).toBe(tmpdir());
    expect(options.cwd).not.toBe(process.cwd());
    expect(options.timeout).toBe(1234);
    expect(options.env['PATH']?.startsWith(npmEnv(process.execPath, {}).PATH!)).toBe(true);
  });
});

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

describe('npmEnv', () => {
  it('finds npm under the bare PATH launchd gives a service', () => {
    // The failure it exists for: nvm/Homebrew npm is not on /usr/bin:/bin.
    const env = npmEnv(process.execPath, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
    expect(execFileSync('npm', ['--version'], { env, encoding: 'utf8' }).trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
