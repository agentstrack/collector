/**
 * Self-update.
 *
 * The collector runs unattended under launchd or systemd, so a fix like
 * "login went to the wrong host" otherwise waits for someone to notice and
 * run npm by hand on every machine. This closes that gap: check the registry,
 * install a newer version, and exit so the supervisor starts the new code.
 *
 * Three things make that safe enough to do without a human:
 *
 * 1. It only ever installs THIS package from the public registry, by exact
 *    version, and only when the running copy is itself a global npm install.
 *    A checkout being developed against is never touched — `npm i -g` over a
 *    working tree would replace the thing the author is editing.
 * 2. The restart is an exit, not an exec. Both supervisors restart on failure
 *    (`KeepAlive{SuccessfulExit:false}`, `Restart=on-failure`), so exiting
 *    non-zero is the documented way back up, and the process never has to
 *    hand its own file descriptors to a new binary.
 * 3. One attempt per version, remembered across restarts. systemd gives up
 *    after `StartLimitBurst=5` starts in 300s, so an update that installs but
 *    cannot run would take the service down permanently if it retried each
 *    boot. Recording the attempt means a bad release costs one restart, then
 *    a log line, and the old version keeps collecting.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const REGISTRY_URL = 'https://registry.npmjs.org/@agentstrack/collector';
export const PACKAGE_NAME = '@agentstrack/collector';

/** Exit code that means "updated, please start me again". Distinct from a crash. */
export const EXIT_UPDATED = 70;

/**
 * Compare two semver-ish versions. Returns >0 when `a` is newer.
 *
 * Deliberately small rather than a dependency — this package installs
 * globally on developer machines and every dependency is supply-chain
 * surface. Prerelease tags sort as older than the release they precede, which
 * is the only prerelease rule that matters here: we never want to jump from
 * 0.5.0 onto 0.5.1-rc.1 automatically.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = '', pre] = v.split('-', 2);
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { nums, pre };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (left.pre && !right.pre) return -1;
  if (!left.pre && right.pre) return 1;
  return 0;
}

/** The newest non-prerelease version on the registry, or null if unreachable. */
export async function latestVersion(timeoutMs = 10_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { 'dist-tags'?: Record<string, string> };
    const latest = body['dist-tags']?.latest;
    return typeof latest === 'string' && !latest.includes('-') ? latest : null;
  } catch {
    // Offline, DNS down, registry having a day. Never fatal: a collector that
    // cannot check for updates must still collect.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether this process is a global npm install we may replace.
 *
 * `npm i -g` against a repo checkout would overwrite whatever the author is
 * working on, and the launchd unit used to point straight at a working tree,
 * so this is a real shape and not a hypothetical one.
 */
export function selfUpdatable(modulePath: string): { ok: boolean; reason?: string } {
  if (!modulePath.includes('node_modules')) {
    return { ok: false, reason: 'running from a source checkout, not a global install' };
  }
  if (!modulePath.includes('@agentstrack')) {
    return { ok: false, reason: 'not running from the published package path' };
  }
  return { ok: true };
}

/** Install an exact version globally. Returns the version actually on disk after. */
export async function installVersion(version: string, timeoutMs = 180_000): Promise<string | null> {
  // Exact version, never a range or a dist-tag: whatever was decided from the
  // registry read is what gets installed, so the log line and the artifact
  // cannot disagree.
  await run('npm', ['install', '--global', `${PACKAGE_NAME}@${version}`, '--prefer-online'], {
    timeout: timeoutMs,
  });
  try {
    const { stdout } = await run('npm', ['ls', '--global', '--depth', '0', '--json'], {
      timeout: 30_000,
    });
    const tree = JSON.parse(stdout) as { dependencies?: Record<string, { version?: string }> };
    return tree.dependencies?.[PACKAGE_NAME]?.version ?? null;
  } catch {
    return null;
  }
}
