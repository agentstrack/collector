import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * Whole CLI invocations, in-process, against a throwaway home. Nothing here
 * runs a command that installs or removes a service.
 */
const dirs: string[] = [];
const env = { ...process.env };
let server: Server | undefined;
afterEach(() => {
  process.env = { ...env };
  process.exitCode = undefined;
  vi.restoreAllMocks();
  server?.close();
  server = undefined;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function home(config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentstrack-cli-'));
  dirs.push(dir);
  if (config !== undefined) {
    mkdirSync(join(dir, '.agentstrack'));
    writeFileSync(join(dir, '.agentstrack', 'config.yaml'), config);
  }
  return dir;
}

const LOGGED_IN = 'api_key: at_test\ncollector_id: 00000000-0000-4000-8000-000000000000\n';

async function cli(dir: string, ...args: string[]): Promise<{ out: string; code: number }> {
  vi.resetModules();
  Object.assign(process.env, {
    HOME: dir,
    AGENTSTRACK_HOME: join(dir, '.agentstrack'),
    CLAUDE_CONFIG_DIR: join(dir, '.claude'),
    CODEX_HOME: join(dir, '.codex'),
  });
  const lines: string[] = [];
  const capture = (...a: unknown[]) => void lines.push(a.join(' '));
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  process.exitCode = undefined;
  process.argv = ['node', 'agentstrack', ...args];
  const { done } = await import('./cli.js');
  await done;
  return { out: lines.join('\n'), code: Number(process.exitCode ?? 0) };
}

describe('cli', () => {
  it('status --json exits 0 when not configured and creates no spool', async () => {
    const dir = home();
    const { out, code } = await cli(dir, 'status', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ configured: false, logged_in: false, queue_depth: 0 });
    expect(existsSync(join(dir, '.agentstrack', 'spool.db'))).toBe(false);
  });

  it('summary --days rejects a non-number with exit 2', async () => {
    const { out, code } = await cli(home(LOGGED_IN), 'summary', '--days', 'abc');
    expect(code).toBe(2);
    expect(out).toContain('--days');
  });

  it('start --agent rejects an unknown agent id', async () => {
    const { out, code } = await cli(home(LOGGED_IN), 'start', '--foreground', '--agent', 'codex,nope');
    expect(code).toBe(2);
    expect(out).toContain('Unknown agent: nope');
  });

  /** A server that answers GET /v1/collector/config and accepts POST /v1/events/batch. */
  async function configServer(received: unknown[] = []): Promise<number> {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/events/batch') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          const raw = req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body;
          const { events } = JSON.parse(raw.toString('utf8')) as { events: unknown[] };
          received.push(...events);
          res.end(JSON.stringify({ accepted: events.length, duplicates: 0, rejected: [] }));
        });
        return;
      }
      res.end(JSON.stringify({
        privacy_mode: 'analytics', idle_timeout_seconds: 120, retention_days: 30, redaction_rules: [],
        max_batch_events: 100, batch_interval_seconds: 30,
      }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  it('sync --dry-run shows what a scan would send without persisting anything', async () => {
    const port = await configServer();
    const dir = home(`${LOGGED_IN}api_url: http://127.0.0.1:${port}\ntracking:\n  agents: [codex]\n  git_metadata: false\n`);
    const day = join(dir, '.codex', 'sessions', '2026', '08', '26');
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, 'rollout-2026-08-26T09-00-00-019d94f1-c8eb-7582-9345-71eace2149f6.jsonl'),
      readFileSync(join(import.meta.dirname, '../test/fixtures/codex-session.jsonl')),
    );

    const { out, code } = await cli(dir, 'sync', '--dry-run');
    expect(code).toBe(0);
    expect(out).toMatch(/\d+ event\(s\) would be sent/);
    expect(out).toContain('session.started');
    // No spool, so no checkpoint or queued event, was written for real.
    expect(existsSync(join(dir, '.agentstrack', 'spool.db'))).toBe(false);
    // Nor did the throwaway scan claim, in the real log, to have queued anything.
    const logPath = join(dir, '.agentstrack', 'collector.log');
    expect(existsSync(logPath) ? readFileSync(logPath, 'utf8') : '').not.toMatch(/Queued \d+ events/);
  });

  const codexHome = (dir: string) => {
    const day = join(dir, '.codex', 'sessions', '2026', '08', '26');
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, 'rollout-2026-08-26T09-00-00-019d94f1-c8eb-7582-9345-71eace2149f6.jsonl'),
      readFileSync(join(import.meta.dirname, '../test/fixtures/codex-session.jsonl')),
    );
  };

  it('plain sync scans first on a fresh install, so it uploads what --dry-run showed', async () => {
    const received: unknown[] = [];
    const port = await configServer(received);
    const dir = home(`${LOGGED_IN}api_url: http://127.0.0.1:${port}\ntracking:\n  agents: [codex]\n  git_metadata: false\n`);
    codexHome(dir);
    const dry = await cli(dir, 'sync', '--dry-run');
    const shown = Number(/(\d+) event\(s\) would be sent/.exec(dry.out)?.[1]);
    expect(shown).toBeGreaterThan(0);

    const { out, code } = await cli(dir, 'sync');
    expect(code).toBe(0);
    expect(out).not.toContain('Queue is already empty');
    expect(received).toHaveLength(shown);
  });

  it('plain sync leaves scanning and uploading to a running collector', async () => {
    const received: unknown[] = [];
    const port = await configServer(received);
    const dir = home(`${LOGGED_IN}api_url: http://127.0.0.1:${port}\ntracking:\n  agents: [codex]\n  git_metadata: false\n`);
    codexHome(dir);
    // Something already queued, which the daemon is (or will be) flushing itself.
    const { Spool } = await import('./queue/spool.js');
    const spool = new Spool(join(dir, '.agentstrack', 'spool.db'));
    spool.enqueue([{
      event_id: '00000000-0000-4000-8000-0000000000e1', schema_version: '1', occurred_at: new Date().toISOString(),
      collector_id: '00000000-0000-4000-8000-000000000000', session_id: 's1', agent: 'codex', event_type: 'heartbeat', payload: {},
    } as never]);
    spool.close();
    // This test process stands in for a live daemon holding the pid file.
    writeFileSync(join(dir, '.agentstrack', 'collector.pid'), String(process.pid));

    const { out, code } = await cli(dir, 'sync');
    expect(code).toBe(0);
    expect(out).toContain('running collector reads and uploads new events itself');
    expect(received).toHaveLength(0);
  });

  it('sync --dry-run on a registered device that has never reached the server says so and exits 1', async () => {
    // A port nothing listens on: the config fetch fails at once.
    const port = await configServer();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const dir = home(`${LOGGED_IN}api_url: http://127.0.0.1:${port}\ntracking:\n  agents: [codex]\n  git_metadata: false\n`);
    codexHome(dir);

    const { out, code } = await cli(dir, 'sync', '--dry-run');
    expect(code).toBe(1);
    expect(out).toContain('Org policy not fetched yet');
    expect(out).not.toContain('nothing would be sent');
  });

  it('doctor passes with one agent installed and another simply absent, without creating a spool', async () => {
    const port = await configServer();
    const dir = home(`${LOGGED_IN}api_url: http://127.0.0.1:${port}\ntracking:\n  agents: [claude_code, codex]\n`);
    mkdirSync(join(dir, '.codex', 'sessions'), { recursive: true });

    const { out, code } = await cli(dir, 'doctor');
    expect(out).toMatch(/claude_code.*not installed/);
    expect(out).toContain('No problems found.');
    expect(code).toBe(0);
    expect(existsSync(join(dir, '.agentstrack', 'spool.db'))).toBe(false);
  });
});
