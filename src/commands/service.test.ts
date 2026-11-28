import { describe, expect, it } from 'vitest';
import { systemdUnit } from './service.js';

describe('systemdUnit — paths are literal, not specifiers', () => {
  it('escapes % everywhere and $ on the ExecStart line only', () => {
    const unit = systemdUnit('/opt/n%de/$HOME/node', '/x/cli.js', '/home/u/100%/.agentstrack', '/home/u/$x%y');
    expect(unit).toContain('ExecStart="/opt/n%%de/$$HOME/node" "/x/cli.js" start --foreground');
    expect(unit).toContain('Environment=AGENTSTRACK_HOME="/home/u/$x%%y"');
    // Not quoted: systemd takes the rest of the line as the path and does not unquote it.
    expect(unit).toContain('WorkingDirectory=/home/u/100%%/.agentstrack\n');
  });

  it('refuses a newline that would inject a directive', () => {
    expect(() => systemdUnit('/n', '/c', '/home/u\nExecStartPre=/bin/evil')).toThrow(/newline/);
  });

  it('omits Environment= when AGENTSTRACK_HOME is unset', () => {
    expect(systemdUnit('/n', '/c', '/d')).not.toContain('Environment=');
  });
});
