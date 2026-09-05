#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { platform, arch } from 'node:os';
import { machineInfo } from './machine.js';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { stringify } from 'yaml';
import {
  CONFIG_PATH, LOG_PATH, PID_PATH, SPOOL_PATH, loadConfig, saveConfig, Config, configExists,
} from './config.js';
import { Collector, VERSION, buildAdapters, errorMessage, listTranscripts, log } from './daemon.js';
import { ApiClient } from './transport/client.js';
import { Spool } from './queue/spool.js';
import { installService, uninstallService, servicePath } from './commands/service.js';
import { clampPrivacyMode } from './privacy/mode.js';

const program = new Command();

program
  .name('agentstrack')
  .description('Privacy-first telemetry collector for AI coding agents')
  .version(VERSION);

// ------------------------------------------------------------------ login

program
  .command('login')
  .description('Authenticate this device with an AgentsTrack API key')
  // Optional: an API key on the command line lands in shell history and `ps`.
  // Prefer the AGENTSTRACK_API_KEY env var, or a stdin prompt / pipe.
  .argument('[api-key]', 'API key from your dashboard (Settings → API keys)')
  .option('--api-url <url>', 'AgentsTrack API base URL (for self-hosted instances)')
  .option('--label <name>', 'friendly name for this device in the dashboard')
  .action(async (apiKeyArg: string | undefined, options: { apiUrl?: string; label?: string }) => {
    const apiKey = await resolveApiKey(apiKeyArg);
    if (!apiKey) {
      console.error(pc.red('✗') + ' No API key provided.');
      console.error(pc.dim('  Pass it as an argument, set AGENTSTRACK_API_KEY, or pipe it on stdin.'));
      process.exitCode = 1;
      return;
    }

    const existing = configExists() ? loadConfig() : Config.parse({});
    // Config.parse enforces the https-only rule (http allowed for localhost),
    // so a bad --api-url is rejected here with a clear message rather than on
    // the next start.
    let config: Config;
    try {
      config = Config.parse({
        ...existing,
        api_url: options.apiUrl ?? existing.api_url,
        api_key: apiKey,
        // A new key may belong to a different org, so re-register.
        collector_id: undefined,
      });
    } catch (error) {
      console.error(pc.red('✗') + ` ${errorMessage(error)}`);
      process.exitCode = 1;
      return;
    }

    console.log(pc.dim(`Connecting to ${config.api_url}…`));
    const client = new ApiClient({ apiUrl: config.api_url, apiKey });
    try {
      const adapters = buildAdapters(config);
      const agents = await Promise.all(
        adapters.map(async (a) => ({ agent: a.id, version: (await a.detect()).version })),
      );
      const result = await client.registerCollector({
        ...machineInfo(),
        label: options.label,
        version: VERSION,
        privacy_mode: config.privacy.mode,
        agents,
      });
      config.collector_id = result.collector_id;
      // The org policy is a ceiling. A developer who chose a stricter mode
      // keeps it — login must never widen what leaves this machine.
      const effectiveMode = clampPrivacyMode(
        config.privacy.mode,
        result.privacy_mode as Config['privacy']['mode'],
      );
      config.privacy = { ...config.privacy, mode: effectiveMode };
      saveConfig(config);

      console.log(pc.green('✓') + ` Logged in and registered this device.`);
      console.log(`  Collector: ${pc.dim(result.collector_id)}`);
      console.log(
        `  Privacy:   ${pc.bold(effectiveMode)}` +
          (effectiveMode !== result.privacy_mode
            ? pc.dim(` (your local setting; org allows ${result.privacy_mode})`)
            : ''),
      );
      console.log(`  Config:    ${pc.dim(CONFIG_PATH)}`);
      console.log(`\nNext: ${pc.cyan('agentstrack start')}`);
    } catch (error) {
      console.error(pc.red('✗') + ` Login failed: ${errorMessage(error)}`);
      console.error(pc.dim('  Check the key, and --api-url if you self-host.'));
      process.exitCode = 1;
    }
  });

program
  .command('logout')
  .description('Remove the stored API key from this device')
  .option('--purge', 'also delete the local spool of unsent events')
  .action((options: { purge?: boolean }) => {
    if (!configExists()) {
      console.log('Not logged in.');
      return;
    }
    // Clearing the key would leave a still-installed service restarting an
    // unauthenticated collector, so tear it down first.
    const unit = uninstallService();
    if (unit) console.log(pc.dim(`  Removed service unit (${unit}).`));
    if (existsSync(PID_PATH)) killCollector();
    const config = loadConfig();
    saveConfig({ ...config, api_key: undefined, collector_id: undefined });

    if (options.purge) {
      // Destructive and deliberate: unsent telemetry is discarded, not queued
      // for the next login.
      try {
        for (const suffix of ['', '-wal', '-shm']) unlinkSync(`${SPOOL_PATH}${suffix}`);
      } catch {
        // Some journal files may not exist; removing the main db is what counts.
      }
      console.log(pc.green('✓') + ' Logged out and purged the local spool.');
      return;
    }
    console.log(pc.green('✓') + ' Logged out. Queued events are kept in the spool.');
  });

// ------------------------------------------------------------------ run

program
  .command('start')
  .description('Start collecting (installs a background service unless --foreground)')
  .option('-f, --foreground', 'run in this terminal instead of as a service')
  .action(async (options: { foreground?: boolean }) => {
    // Exit 0 (not 1) when unauthenticated: the launchd/systemd unit runs
    // `start --foreground`, and a non-zero exit makes the supervisor respawn it
    // on a loop. A clean exit lets it idle until the user logs in again.
    if (!configExists() || !loadConfig().api_key) {
      const msg = 'Not logged in — collector idle. Run: agentstrack login';
      console.log(pc.yellow('!') + ' ' + msg);
      log(msg);
      return;
    }
    const config = loadConfig();

    if (!options.foreground) {
      const cliPath = fileURLToPath(import.meta.url);
      const target = installService(process.execPath, cliPath);
      console.log(pc.green('✓') + ` Collector service installed and started.`);
      console.log(`  Unit: ${pc.dim(target)}`);
      console.log(`  Logs: ${pc.dim(LOG_PATH)}`);
      console.log(`\nCheck it: ${pc.cyan('agentstrack status')}`);
      return;
    }

    // Two collectors on one spool and one set of transcripts double-count and
    // race the pid file, so refuse a second foreground start.
    if (isRunning()) {
      console.error(pc.red('✗') + ` Collector already running (pid ${readFileSync(PID_PATH, 'utf8').trim()}).`);
      process.exit(1);
    }
    // A stale pid file (previous crash) is safe to clear now that isRunning()
    // has confirmed no live process holds it; 'wx' then makes the create fail
    // if a racing start beat us to it.
    try {
      unlinkSync(PID_PATH);
    } catch {
      // Nothing to remove.
    }
    try {
      writeFileSync(PID_PATH, String(process.pid), { flag: 'wx' });
    } catch {
      console.error(pc.red('✗') + ' Another collector just started. Aborting.');
      process.exit(1);
    }
    const collector = new Collector(config);

    const shutdown = () => {
      console.log('\nStopping…');
      collector.stop();
      try {
        unlinkSync(PID_PATH);
      } catch {
        // Already gone.
      }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    console.log(pc.green('▶') + ' Collector running. Ctrl-C to stop.');
    await collector.start();
  });

program
  .command('stop')
  .description('Stop the collector and remove its background service')
  .action(() => {
    const unit = uninstallService();
    if (existsSync(PID_PATH)) killCollector();
    console.log(pc.green('✓') + (unit ? ` Service removed (${unit}).` : ' Collector stopped.'));
  });

// ------------------------------------------------------------------ inspect

program
  .command('status')
  .description('Show collector health, queue depth and detected agents')
  .option('--json', 'machine-readable output')
  .action(async (options: { json?: boolean }) => {
    if (options.json) {
      const config = configExists() ? loadConfig() : null;
      const spool = new Spool(SPOOL_PATH);
      const depth = spool.depth();
      spool.close();
      const agents = config
        ? await Promise.all(
            buildAdapters(config).map(async (a) => ({ agent: a.id, ...(await a.health()) })),
          )
        : [];
      console.log(
        JSON.stringify(
          {
            version: VERSION,
            configured: Boolean(config),
            logged_in: Boolean(config?.api_key),
            api_url: config?.api_url ?? null,
            collector_id: config?.collector_id ?? null,
            privacy_mode: config?.privacy.mode ?? null,
            queue_depth: depth,
            running: isRunning(),
            service_installed: existsSync(servicePath()),
            agents,
          },
          null,
          2,
        ),
      );
      if (!config?.api_key) process.exitCode = 1;
      return;
    }
    if (!configExists()) {
      console.log(pc.yellow('!') + ' Not configured. Run: ' + pc.cyan('agentstrack login <api-key>'));
      return;
    }
    const config = loadConfig();
    const spool = new Spool(SPOOL_PATH);
    const depth = spool.depth();
    // Track F1 pauses uploads (e.g. over quota) by writing a reason here; show
    // it so a growing queue does not look like an unexplained failure.
    const pausedReason = spool.getMeta('upload_paused_reason');
    spool.close();

    console.log(pc.bold('AgentsTrack collector') + pc.dim(` v${VERSION}`));
    console.log(`  Logged in:   ${config.api_key ? pc.green('yes') : pc.red('no')}`);
    console.log(`  API:         ${config.api_url}`);
    console.log(`  Collector:   ${config.collector_id ?? pc.dim('not registered')}`);
    console.log(`  Privacy:     ${pc.bold(config.privacy.mode)}`);
    console.log(`  Queue depth: ${depth === 0 ? pc.green('0') : pc.yellow(String(depth))}`);
    if (pausedReason) console.log(`  Uploads:     ${pc.yellow('paused')} ${pc.dim(`(${pausedReason})`)}`);
    console.log(`  Service:     ${existsSync(servicePath()) ? pc.green('installed') : pc.dim('not installed')}`);
    console.log(`  Running:     ${isRunning() ? pc.green('yes') : pc.yellow('no')}`);

    console.log('\n' + pc.bold('Agents'));
    for (const adapter of buildAdapters(config)) {
      const health = await adapter.health();
      const mark = health.healthy ? pc.green('✓') : pc.red('✗');
      // "sessions" rather than "transcripts": OpenCode keeps rows in a database,
      // not one file per session, and the count means the same thing either way.
      console.log(`  ${mark} ${adapter.id.padEnd(14)} ${health.healthy ? `${health.filesTracked} sessions` : health.error ?? 'unavailable'}`);
    }
  });

program
  .command('doctor')
  .description('Diagnose setup problems')
  .option('--json', 'machine-readable output (paste this into a bug report)')
  .action(async (options: { json?: boolean }) => {
    if (options.json) {
      process.exitCode = (await doctorJson()) ? 0 : 1;
      return;
    }
    let problems = 0;
    const check = (ok: boolean, label: string, hint?: string) => {
      console.log(`  ${ok ? pc.green('✓') : pc.red('✗')} ${label}`);
      if (!ok && hint) console.log(`    ${pc.dim(hint)}`);
      if (!ok) problems += 1;
    };

    console.log(pc.bold('Configuration'));
    check(configExists(), `config exists at ${CONFIG_PATH}`, 'Run: agentstrack login <api-key>');
    if (!configExists()) {
      process.exitCode = 1;
      return;
    }
    const config = loadConfig();
    check(Boolean(config.api_key), 'API key present', 'Run: agentstrack login <api-key>');
    check(Boolean(config.collector_id), 'device registered', 'Run: agentstrack login <api-key> again');

    console.log('\n' + pc.bold('Agents'));
    for (const adapter of buildAdapters(config)) {
      const detection = await adapter.detect();
      check(detection.installed, `${adapter.id} sessions found`, detection.note);
      if (!detection.installed) continue;
      if (detection.watchPaths.length > 0) {
        const files = detection.watchPaths.flatMap((p) => listTranscripts(p, config.tracking.max_age_days));
        const days = config.tracking.max_age_days;
        console.log(`    ${pc.dim(`${files.length} file(s) modified in the last ${days} day${days === 1 ? '' : 's'}`)}`);
      } else {
        // A database-backed adapter has no files to count; name the source instead
        // of reporting a confident zero.
        const health = await adapter.health();
        console.log(`    ${pc.dim(`${health.filesTracked} session(s) in ${detection.note ?? 'the agent database'}`)}`);
      }
    }

    console.log('\n' + pc.bold('Connectivity'));
    if (config.api_key) {
      const client = new ApiClient({ apiUrl: config.api_url, apiKey: config.api_key, timeoutMs: 10_000 });
      try {
        const server = await client.getConfig();
        check(true, `API reachable at ${config.api_url}`);
        console.log(`    ${pc.dim(`org privacy mode: ${server.privacy_mode}, retention ${server.retention_days}d`)}`);
      } catch (error) {
        check(false, `API reachable at ${config.api_url}`, errorMessage(error));
      }
    }

    console.log('\n' + pc.bold('Queue'));
    const spool = new Spool(SPOOL_PATH);
    const depth = spool.depth();
    spool.close();
    check(depth < 10_000, `queue depth ${depth}`, 'A large backlog means uploads are failing — check the log.');
    console.log(`    ${pc.dim(`log: ${LOG_PATH}`)}`);

    console.log(
      '\n' + (problems === 0 ? pc.green('No problems found.') : pc.red(`${problems} problem(s) found.`)),
    );
    if (problems > 0) process.exitCode = 1;
  });

// ------------------------------------------------------------------ config

program
  .command('config')
  .description('Show the current configuration (the API key is masked)')
  .option('--path', 'print the config file path and exit')
  .option('--show-effective', 'include values filled in from defaults')
  .action((options: { path?: boolean; showEffective?: boolean }) => {
    if (options.path) {
      console.log(CONFIG_PATH);
      return;
    }
    if (options.showEffective) {
      // loadConfig() already applies every zod default, so this is the config
      // the collector actually runs with — not just what is on disk.
      const effective = configExists() ? loadConfig() : Config.parse({});
      console.log(stringify({ ...effective, api_key: effective.api_key ? '***masked***' : undefined }));
      return;
    }
    if (!configExists()) {
      console.log(pc.yellow('!') + ' No config yet. Run: ' + pc.cyan('agentstrack login <api-key>'));
      return;
    }
    const config = loadConfig();
    console.log(stringify({ ...config, api_key: config.api_key ? '***masked***' : undefined }));
  });

program
  .command('sync')
  .description('Upload any queued events now and exit')
  .option('--dry-run', 'show what would be uploaded without sending anything')
  .option('--print', 'with --dry-run, print the full event bodies')
  .action(async (options: { dryRun?: boolean; print?: boolean }) => {
    const config = requireLogin();

    if (options.dryRun) {
      // The privacy claim made verifiable: this is exactly what would leave
      // the machine, after redaction, with nothing sent.
      const spool = new Spool(SPOOL_PATH);
      const pending = spool.peek(config.upload.batch_size);
      spool.close();
      if (pending.length === 0) {
        console.log(pc.green('✓') + ' Nothing queued — nothing would be sent.');
        return;
      }
      console.log(`${pending.length} event(s) would be sent to ${config.api_url}:\n`);
      if (options.print) {
        for (const item of pending) console.log(JSON.stringify(item.event, null, 2));
      } else {
        const byType = new Map<string, number>();
        for (const item of pending) {
          byType.set(item.event.event_type, (byType.get(item.event.event_type) ?? 0) + 1);
        }
        for (const [type, count] of [...byType].sort((a, b) => b[1] - a[1])) {
          console.log(`  ${String(count).padStart(5)}  ${type}`);
        }
        console.log(pc.dim('\n  Re-run with --print to see the full event bodies.'));
      }
      return;
    }

    const collector = new Collector(config);
    const before = collector.queueDepth();
    if (before === 0) {
      console.log(pc.green('✓') + ' Queue is already empty.');
      collector.stop();
      return;
    }
    console.log(`Uploading ${before} queued events…`);
    await collector.flush();
    const after = collector.queueDepth();
    collector.stop();
    console.log(
      after === 0
        ? pc.green('✓') + ` Uploaded ${before} events.`
        : pc.yellow('!') + ` ${after} events still queued — see ${LOG_PATH}`,
    );
    if (after > 0) process.exitCode = 1;
  });

program
  .command('service')
  .description('Manage the background service')
  .argument('<action>', 'install | uninstall')
  .action((action: string) => {
    if (action === 'install') {
      requireLogin();
      const cliPath = fileURLToPath(import.meta.url);
      console.log(pc.green('✓') + ` Installed: ${installService(process.execPath, cliPath)}`);
    } else if (action === 'uninstall') {
      const removed = uninstallService();
      console.log(removed ? pc.green('✓') + ` Removed: ${removed}` : 'No service installed.');
    } else {
      console.error(pc.red('✗') + ' Unknown action. Use: install | uninstall');
      process.exitCode = 1;
    }
  });

/**
 * Signals the foreground collector named by the pid file, but only after
 * confirming the pid still belongs to a collector — a stale file may now point
 * at an unrelated, recycled pid, which we must not kill.
 */
function killCollector(): void {
  const pid = Number(readFileSync(PID_PATH, 'utf8').trim());
  const removePid = () => {
    try {
      unlinkSync(PID_PATH);
    } catch {
      // Already gone.
    }
  };
  if (!Number.isInteger(pid) || pid <= 0) {
    removePid();
    return;
  }
  let command = '';
  try {
    command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  } catch {
    // No such process — the pid file is stale.
    removePid();
    return;
  }
  if (!command.includes('agentstrack')) {
    // The pid was recycled by an unrelated process; drop the stale file only.
    removePid();
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process already exited.
  }
  removePid();
}

/** True when a foreground collector holds the pid file. */
function isRunning(): boolean {
  if (!existsSync(PID_PATH)) return false;
  const pid = Number(readFileSync(PID_PATH, 'utf8'));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // stale pid file
  }
}

/** Structured diagnostics — this is what bug reports ask for. */
async function doctorJson(): Promise<boolean> {
  const configured = configExists();
  const config = configured ? loadConfig() : null;
  const spool = new Spool(SPOOL_PATH);
  const depth = spool.depth();
  spool.close();

  const agents = config
    ? await Promise.all(
        buildAdapters(config).map(async (a) => {
          const [detection, health] = await Promise.all([a.detect(), a.health()]);
          return {
            agent: a.id,
            installed: detection.installed,
            healthy: health.healthy,
            files_tracked: health.filesTracked,
            note: detection.note ?? health.error ?? null,
          };
        }),
      )
    : [];

  let api: { reachable: boolean; error?: string; privacy_mode?: string } = { reachable: false };
  if (config?.api_key) {
    try {
      const server = await new ApiClient({
        apiUrl: config.api_url,
        apiKey: config.api_key,
        timeoutMs: 10_000,
      }).getConfig();
      api = { reachable: true, privacy_mode: server.privacy_mode };
    } catch (error) {
      api = { reachable: false, error: errorMessage(error) };
    }
  }

  const report = {
    version: VERSION,
    node: process.version,
    platform: `${platform()}-${arch()}`,
    configured,
    logged_in: Boolean(config?.api_key),
    collector_id: config?.collector_id ?? null,
    privacy_mode: config?.privacy.mode ?? null,
    api_url: config?.api_url ?? null,
    api,
    queue_depth: depth,
    running: isRunning(),
    service_installed: existsSync(servicePath()),
    agents,
    log_path: LOG_PATH,
  };
  console.log(JSON.stringify(report, null, 2));

  return (
    configured && Boolean(config?.api_key) && api.reachable && agents.some((a) => a.installed)
  );
}

/**
 * Resolves the API key from, in order: the argument, AGENTSTRACK_API_KEY, or
 * stdin (a pipe, or an echo-off prompt on a TTY). Keeps the key off the command
 * line and out of shell history when the caller wants it to be.
 */
async function resolveApiKey(arg?: string): Promise<string> {
  if (arg) return arg.trim();
  const fromEnv = process.env['AGENTSTRACK_API_KEY'];
  if (fromEnv) return fromEnv.trim();
  if (!process.stdin.isTTY) {
    // Piped: `agentstrack login < key.txt`.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  return promptSecret('API key: ');
}

/** Reads one line from a TTY without echoing it. */
function promptSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Suppress echo of the typed characters; still let the prompt and newline through.
    const muted = rl as unknown as { _writeToOutput?: (s: string) => void };
    muted._writeToOutput = (s: string) => {
      if (s.includes(prompt) || s.includes('\n') || s.includes('\r')) process.stdout.write(s);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function requireLogin(): Config {
  if (!configExists()) {
    console.error(pc.red('✗') + ' Not logged in. Run: ' + pc.cyan('agentstrack login <api-key>'));
    process.exit(1);
  }
  const config = loadConfig();
  if (!config.api_key) {
    console.error(pc.red('✗') + ' No API key. Run: ' + pc.cyan('agentstrack login <api-key>'));
    process.exit(1);
  }
  return config;
}

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(pc.red('✗') + ` ${errorMessage(error)}`);
  log(`CLI error: ${errorMessage(error)}`);
  process.exit(1);
});
