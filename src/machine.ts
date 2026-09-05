import { existsSync, readFileSync } from 'node:fs';
import { arch, hostname, platform, release } from 'node:os';

/**
 * What kind of machine this collector runs on.
 *
 * Sent with register and health so the server can tell a developer's laptop
 * from a CI runner or a shared build box — the same session shape means
 * different things on each. It is derived locally from cheap probes, never
 * from anything the user typed, and is a coarse label, not an inventory.
 */
export type MachineKind = 'workstation' | 'server' | 'container' | 'ci' | 'unknown';

export interface MachineInfo {
  hostname: string;
  os: string;
  os_release: string;
  arch: string;
  machine_kind: MachineKind;
}

/** The probes detectMachineKind reads. Injected so a test can describe any machine. */
export interface MachineProbes {
  platform: string;
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
}

const CI_VARS = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI'] as const;

export function detectMachineKind(p: MachineProbes): MachineKind {
  if (CI_VARS.some((v) => p.env[v])) return 'ci';
  if (p.exists('/.dockerenv') || /docker|containerd|kubepods/.test(safeRead(p, '/proc/1/cgroup'))) return 'container';
  if (p.platform === 'darwin' || p.platform === 'win32') return 'workstation';
  if (p.platform === 'linux') {
    const display = p.env['DISPLAY'] || p.env['WAYLAND_DISPLAY'];
    const graphicalSession = p.env['XDG_SESSION_TYPE'] === 'x11' || p.env['XDG_SESSION_TYPE'] === 'wayland';
    // The daemon usually runs from a systemd --user unit or an SSH shell, where
    // no display variables are imported even on a desktop. An installed desktop
    // session is the evidence that survives that.
    const desktopInstalled = p.exists('/usr/share/xsessions') || p.exists('/usr/share/wayland-sessions');
    return display || graphicalSession || desktopInstalled ? 'workstation' : 'server';
  }
  return 'unknown';
}

function safeRead(p: MachineProbes, path: string): string {
  try {
    return p.exists(path) ? p.readFile(path) : '';
  } catch {
    return '';
  }
}

/** Facts about this machine, for register and health. Recomputed on every call so
 *  health can report a device that changed shape (a GUI session that came up after boot). */
export function machineInfo(): MachineInfo {
  return {
    hostname: hostname(),
    os: platform(),
    os_release: release(),
    arch: arch(),
    machine_kind: detectMachineKind({
      platform: platform(),
      env: process.env,
      exists: existsSync,
      readFile: (path) => readFileSync(path, 'utf8'),
    }),
  };
}
