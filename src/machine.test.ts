import { describe, expect, it } from 'vitest';
import { detectMachineKind, type MachineProbes } from './machine.js';

const probes = (over: Partial<MachineProbes> & { files?: Record<string, string> }): MachineProbes => ({
  platform: over.platform ?? 'linux',
  env: over.env ?? {},
  exists: (path) => path in (over.files ?? {}),
  readFile: (path) => over.files?.[path] ?? '',
});

describe('detectMachineKind', () => {
  it('classifies from cheap local probes, most specific first', () => {
    expect(detectMachineKind(probes({ platform: 'darwin', env: { GITHUB_ACTIONS: 'true' } }))).toBe('ci');
    expect(detectMachineKind(probes({ files: { '/.dockerenv': '' } }))).toBe('container');
    expect(detectMachineKind(probes({ files: { '/proc/1/cgroup': '0::/kubepods/pod1/abc' } }))).toBe('container');
    expect(detectMachineKind(probes({ platform: 'darwin' }))).toBe('workstation');
    expect(detectMachineKind(probes({ platform: 'win32' }))).toBe('workstation');
    expect(detectMachineKind(probes({ env: { DISPLAY: ':0' } }))).toBe('workstation');
    expect(detectMachineKind(probes({ env: { XDG_SESSION_TYPE: 'wayland' } }))).toBe('workstation');
    // A desktop reached over SSH or run from a systemd --user unit has no display
    // variables; the installed session directory is what still says "desktop".
    expect(detectMachineKind(probes({ env: { SSH_CONNECTION: '1.2.3.4 22' }, files: { '/usr/share/xsessions': '' } }))).toBe('workstation');
    expect(detectMachineKind(probes({ env: { SSH_CONNECTION: '1.2.3.4 22' } }))).toBe('server');
    expect(detectMachineKind(probes({}))).toBe('server');
    expect(detectMachineKind(probes({ platform: 'freebsd' }))).toBe('unknown');
  });

  it('never throws when a probe file is unreadable', () => {
    const p = probes({ files: { '/proc/1/cgroup': '' } });
    p.readFile = () => {
      throw new Error('EACCES');
    };
    expect(detectMachineKind(p)).toBe('server');
  });
});
