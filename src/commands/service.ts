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

export function servicePath(): string {
  return platform() === 'darwin'
    ? join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
    : join(homedir(), '.config', 'systemd', 'user', 'agentstrack.service');
}

export function installService(nodePath: string, cliPath: string): string {
  const target = servicePath();
  mkdirSync(join(target, '..'), { recursive: true });

  if (platform() === 'darwin') {
    writeFileSync(
      target,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${cliPath}</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${CONFIG_DIR}</string>
  <key>StandardOutPath</key><string>${LOG_PATH}</string>
  <key>StandardErrorPath</key><string>${LOG_PATH}</string>
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

  writeFileSync(
    target,
    `[Unit]
Description=AgentsTrack collector
After=network-online.target

[Service]
Type=simple
ExecStart=${nodePath} ${cliPath} start --foreground
Restart=always
RestartSec=10
WorkingDirectory=${CONFIG_DIR}

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
