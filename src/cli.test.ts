import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  /** A server that answers GET /v1/collector/config and nothing else. */
  async function configServer(): Promise<number> {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
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
