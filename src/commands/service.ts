import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR, LOG_PATH } from '../config.js';

/**
 * Background service installation.
 *
 * Uses the platform's own supervisor rather than a bespoke daemon: launchd and
 * systemd already handle restart-on-crash, start-at-login and log rotation, so
 * writing our own process manager would be strictly worse.
 */
const LABEL = 'ai.agentstrack.collector';

/** Escapes the five XML predefined entities for safe interpolation into a plist. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Quotes an argument for a systemd ExecStart line (double quotes, backslash-escaped). */
function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function servicePath(): string {
  return platform() === 'darwin'
    ? join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
    : join(homedir(), '.config', 'systemd', 'user', 'agentstrack.service');
}

export function installService(nodePath: string, cliPath: string): string {
  const target = servicePath();
  mkdirSync(join(target, '..'), { recursive: true });

  // Pass AGENTSTRACK_HOME through to the supervised process when the installer
  // ran with it set, so the service reads the same config/spool the user does.
  const home = process.env['AGENTSTRACK_HOME'];

  if (platform() === 'darwin') {
    const envBlock = home
      ? `  <key>EnvironmentVariables</key>
  <dict><key>AGENTSTRACK_HOME</key><string>${xmlEscape(home)}</string></dict>
`
      : '';
    writeFileSync(
      target,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(cliPath)}</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key><true/>
  <!-- Restart on a crash, but not after a clean exit (e.g. logout leaves the
       collector unauthenticated and it exits 0) — a bare <true/> here respawns
       an exit-0 process every 10s forever. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
${envBlock}  <key>WorkingDirectory</key><string>${xmlEscape(CONFIG_DIR)}</string>
  <key>StandardOutPath</key><string>${xmlEscape(LOG_PATH)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(LOG_PATH)}</string>
</dict>
</plist>
`,
      'utf8',
    );
    try {
      execFileSync('launchctl', ['unload', target], { stdio: 'ignore' });
    } catch {
      // Not previously loaded — expected on first install.
    }
    execFileSync('launchctl', ['load', target], { stdio: 'ignore' });
    return target;
  }

  const environmentLine = home ? `Environment=AGENTSTRACK_HOME=${systemdQuote(home)}\n` : '';
  writeFileSync(
    target,
    `[Unit]
Description=AgentsTrack collector
After=network-online.target
# Stop respawning after 5 failures in 5 minutes so a persistently broken unit
# (bad path, revoked key) idles instead of looping.
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${systemdQuote(nodePath)} ${systemdQuote(cliPath)} start --foreground
# Restart on failure only; a clean exit (e.g. after logout) must stay stopped.
Restart=on-failure
RestartSec=10
${environmentLine}WorkingDirectory=${CONFIG_DIR}

[Install]
WantedBy=default.target
`,
    'utf8',
  );
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  execFileSync('systemctl', ['--user', 'enable', '--now', 'agentstrack.service'], { stdio: 'ignore' });
  return target;
}

export function uninstallService(): string | null {
  const target = servicePath();
  if (!existsSync(target)) return null;

  try {
    if (platform() === 'darwin') execFileSync('launchctl', ['unload', target], { stdio: 'ignore' });
    else execFileSync('systemctl', ['--user', 'disable', '--now', 'agentstrack.service'], { stdio: 'ignore' });
  } catch {
    // Removing the unit file is what matters; the supervisor may already be stopped.
  }
  unlinkSync(target);
  return target;
}
