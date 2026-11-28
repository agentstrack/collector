import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Collector, ORG_POLICY_META, UPLOAD_PAUSE_META, errorMessage, toPrivacyMode } from './daemon.js';
import { Config, loadConfig, saveConfig } from './config.js';
import { Spool } from './queue/spool.js';
import { tailFile, type TailResult } from './queue/tailer.js';
import { ApiError, type BatchResult, type ServerConfig } from './transport/client.js';
import { SCHEMA_VERSION, type EventEnvelope } from './schema.js';
import type { AgentAdapter, NormalizedEvent } from './adapters/types.js';

// The tailer is replaced so a scan can be driven without agent homes on disk.
vi.mock('./queue/tailer.js', () => ({ tailFile: vi.fn() }));
const tail = vi.mocked(tailFile);
// ensureRegistered writes the real config file; capture it instead.
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  tail.mockReset();
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentstrack-collector-'));
  dirs.push(dir);
  return dir;
};

const COLLECTOR = '00000000-0000-4000-8000-000000000000';
const serverConfig = (over: Partial<ServerConfig> = {}): ServerConfig => ({
  privacy_mode: 'analytics',
  idle_timeout_seconds: 120,
  retention_days: 30,
  redaction_rules: [],
  max_batch_events: 100,
  batch_interval_seconds: 30,
  ...over,
});
const ok = (n: number): BatchResult => ({ accepted: n, duplicates: 0, rejected: [] });

function setup(
  options: {
    spoolPath?: string;
    config?: Record<string, unknown>;
    getConfig?: () => Promise<ServerConfig>;
    sendBatch?: (batch: EventEnvelope[]) => Promise<BatchResult>;
  } = {},
) {
  const spool = new Spool(options.spoolPath ?? join(tempDir(), 'spool.db'));
  const client = {
    sendBatch: vi.fn(options.sendBatch ?? (async (b: EventEnvelope[]) => ok(b.length))),
    registerCollector: vi.fn(),
    getConfig: vi.fn(options.getConfig ?? (async () => serverConfig())),
    health: vi.fn(),
  };
  const config = Config.parse({
    api_key: 'at_test',
    collector_id: COLLECTOR,
    tracking: { git_metadata: false, agents: [] },
    ...options.config,
  });
  return { spool, client, collector: new Collector(config, { spool, client }) };
}

const prompt = (cwd?: string): NormalizedEvent => ({
  event: {
    occurred_at: new Date().toISOString(),
    session_id: 's1',
    agent: 'codex',
    event_type: 'user.prompted',
    payload: { prompt_chars: 12, prompt_text: 'hello acme-42' },
  },
  cwd,
  eventId: randomUUID(),
});

/** What the private enqueue spooled, as it would be sent. */
function sent(spool: Spool): EventEnvelope[] {
  return spool.peek(1000).map((p) => p.event);
}

const offline = async (): Promise<ServerConfig> => {
  throw new ApiError('fetch failed', 0, true);
};

describe('helpers', () => {
  it('reads an unknown privacy mode as the strictest', () => {
    expect(toPrivacyMode('full')).toBe('full');
    expect(toPrivacyMode('everything')).toBe('metadata');
    expect(toPrivacyMode(undefined)).toBe('metadata');
  });

  it('names a timeout as one', () => {
    expect(errorMessage(new Error('This operation was aborted'))).toBe('request timed out');
  });
});

describe('org policy', () => {
  it('clamps once the server is reachable again, and from then on even when it is not', async () => {
    const spoolPath = join(tempDir(), 'spool.db');
    let reachable = false;
    const first = setup({
      spoolPath,
      config: { privacy: { mode: 'full' } },
      getConfig: async () => {
        if (!reachable) return offline();
        return serverConfig({ privacy_mode: 'metadata', redaction_rules: [{ pattern: 'acme-\\d+', replacement: '[org]' }] });
      },
    });
    await first.collector.scanOnce();
    // @ts-expect-error private — never fetched, nothing persisted: the local mode
    expect(first.collector.config.privacy.mode).toBe('full');

    reachable = true;
    // @ts-expect-error private — the retry window has passed
    first.collector.configAttemptAt = 0;
    // @ts-expect-error private
    await first.collector.scan();
    // @ts-expect-error private
    expect(first.collector.config.privacy.mode).toBe('metadata');
    expect(JSON.parse(first.spool.getMeta(ORG_POLICY_META)!)).toMatchObject({ privacy_mode: 'metadata' });
    first.collector.stop();

    // A boot with no network: the persisted ceiling and rules apply at once.
    const second = setup({ spoolPath, config: { privacy: { mode: 'full' } }, getConfig: offline });
    await second.collector.scanOnce();
    // @ts-expect-error private
    expect(second.collector.config.privacy.mode).toBe('metadata');
    // @ts-expect-error private
    expect(second.collector.orgRules).toHaveLength(1);
  });

  it('treats a persisted policy it cannot read as the strictest mode', () => {
    const spoolPath = join(tempDir(), 'spool.db');
    const seed = new Spool(spoolPath);
    seed.setMeta(ORG_POLICY_META, JSON.stringify({ privacy_mode: 'everything', redaction_rules: [] }));
    seed.close();
    const { collector } = setup({ spoolPath, config: { privacy: { mode: 'full' } }, getConfig: offline });
    // @ts-expect-error private
    expect(collector.config.privacy.mode).toBe('metadata');
  });

  describe('before the first successful fetch', () => {
    const adapter: AgentAdapter = {
      id: 'codex',
      detect: async () => ({ installed: true, watchPaths: [] }),
      health: async () => ({ healthy: true, filesTracked: 1 }),
      normalize: () => [],
      poll: async () => [prompt('/w/app')],
    };

    it('reads and spools nothing offline with no persisted policy, then clamps once the server answers', async () => {
      let reachable = false;
      const { spool, collector } = setup({
        config: { privacy: { mode: 'full' } },
        getConfig: async () => (reachable ? serverConfig({ privacy_mode: 'metadata' }) : offline()),
      });
      // @ts-expect-error private
      collector.adapters = [adapter];
      await collector.scanOnce();
      expect(spool.depth()).toBe(0);
      expect(await collector.flush()).toBe(false);

      reachable = true;
      await collector.scanOnce();
      const [event] = sent(spool);
      expect(event!.payload['prompt_text']).toBeUndefined();
      expect(event!.payload['prompt_chars']).toBe(12);
    });

    it('treats unreadable persisted meta as no policy, without throwing in the constructor', async () => {
      for (const raw of ['{not json', JSON.stringify({ privacy_mode: 'full', redaction_rules: 'acme' })]) {
        const spoolPath = join(tempDir(), 'spool.db');
        const seed = new Spool(spoolPath);
        seed.setMeta(ORG_POLICY_META, raw);
        seed.close();
        const { spool, collector } = setup({ spoolPath, config: { privacy: { mode: 'full' } }, getConfig: offline });
        // @ts-expect-error private
        collector.adapters = [adapter];
        await collector.scanOnce();
        expect(spool.depth(), raw).toBe(0);
      }
    });

    it('keeps the valid rules of a persisted policy with one malformed element', () => {
      const spoolPath = join(tempDir(), 'spool.db');
      const seed = new Spool(spoolPath);
      seed.setMeta(
        ORG_POLICY_META,
        JSON.stringify({ privacy_mode: 'analytics', redaction_rules: [{ pattern: 'acme-\\d+', replacement: '[org]' }, { pattern: 7 }] }),
      );
      seed.close();
      const { collector } = setup({ spoolPath, config: { privacy: { mode: 'full' } }, getConfig: offline });
      // @ts-expect-error private
      expect(collector.orgRules).toHaveLength(1);
      // @ts-expect-error private
      expect(collector.config.privacy.mode).toBe('analytics');
    });
  });

  it('saves only the registration over the on-disk config, never a start --agent override', async () => {
    const onDisk = Config.parse({ api_key: 'at_test', tracking: { agents: ['claude_code', 'codex'] }, privacy: { mode: 'full' } });
    vi.mocked(loadConfig).mockReturnValue(onDisk);
    const { client, collector } = setup({
      config: { collector_id: undefined, tracking: { git_metadata: false, agents: ['codex'] }, privacy: { mode: 'analytics' } },
    });
    client.registerCollector.mockResolvedValue({ collector_id: COLLECTOR, privacy_mode: 'full' });
    // @ts-expect-error private
    await collector.ensureRegistered();
    expect(vi.mocked(saveConfig)).toHaveBeenCalledWith({ ...onDisk, collector_id: COLLECTOR });
  });

  it('fetches the server config before a one-shot scan (sync --full)', async () => {
    const { client, collector } = setup();
    await collector.scanOnce();
    expect(client.getConfig).toHaveBeenCalledTimes(1);
    await collector.scanOnce();
    expect(client.getConfig).toHaveBeenCalledTimes(2);
  });
});

describe('session.ended', () => {
  const quiet = () => ({
    event_id: randomUUID(),
    schema_version: SCHEMA_VERSION,
    occurred_at: new Date(Date.now() - 600_000).toISOString(),
    collector_id: COLLECTOR,
    session_id: 's1',
    agent: 'codex' as const,
    event_type: 'tool.completed' as const,
    payload: {},
  });

  it('is not emitted by stop()', () => {
    const { spool, collector } = setup();
    // @ts-expect-error private
    collector.trackSession(quiet());
    const peek = vi.spyOn(spool, 'enqueue');
    collector.stop();
    expect(peek).not.toHaveBeenCalled();
  });

  it('waits while a backfill is still reading, then ends the idle session', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'rollout.jsonl'), '{}\n');
    const adapter: AgentAdapter = {
      id: 'codex',
      detect: async () => ({ installed: true, watchPaths: [dir] }),
      health: async () => ({ healthy: true, filesTracked: 1 }),
      normalize: () => [],
    };
    const { spool, collector } = setup();
    // @ts-expect-error private
    collector.adapters = [adapter];
    // @ts-expect-error private
    collector.trackSession(quiet());
    const result = (more: boolean): TailResult => ({ lines: 1, bytesRead: 1, skipped: 0, more });

    tail.mockResolvedValue(result(true));
    // @ts-expect-error private
    await collector.scan();
    expect(sent(spool).filter((e) => e.event_type === 'session.ended')).toHaveLength(0);

    tail.mockResolvedValue(result(false));
    // @ts-expect-error private
    await collector.scan();
    expect(sent(spool).filter((e) => e.event_type === 'session.ended')).toHaveLength(1);
  });
});

describe('excluded projects, fail closed', () => {
  const scanWith = async (excluded: string[]) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'rollout.jsonl'), '{}\n');
    const adapter: AgentAdapter = {
      id: 'codex',
      detect: async () => ({ installed: true, watchPaths: [dir] }),
      health: async () => ({ healthy: true, filesTracked: 1 }),
      // A resumed line whose project is not known yet.
      normalize: () => [prompt(undefined)],
    };
    const { spool, collector } = setup({ config: { privacy: { excluded_projects: excluded } } });
    // @ts-expect-error private
    collector.adapters = [adapter];
    tail.mockImplementation(async (_path, _spool, onLines) => {
      onLines([{ text: '{}', offset: 0 }]);
      return { lines: 1, bytesRead: 3, skipped: 0, more: false };
    });
    // @ts-expect-error private
    await collector.scan();
    return sent(spool).filter((e) => e.event_type === 'user.prompted');
  };

  it('drops an event with no known project while any exclusion is set', async () => {
    expect(await scanWith(['/w/secret'])).toHaveLength(0);
  });

  it('keeps it when nothing is excluded', async () => {
    expect(await scanWith([])).toHaveLength(1);
  });

  it('excludes on the adapter repo path when cwd is absent', () => {
    const { spool, collector } = setup({ config: { privacy: { excluded_projects: ['/w/secret'] } } });
    const item = { ...prompt(), repo: { project_path: '/w/secret/app' } };
    // @ts-expect-error private
    collector.enqueue([item], COLLECTOR);
    expect(spool.depth()).toBe(0);
  });
});

describe('git.branch_changed', () => {
  const repo = () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    return dir;
  };
  const checkout = (dir: string, branch: string) => writeFileSync(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);

  it('emits from/to when a later read differs, never on the first sighting', () => {
    const dir = repo();
    const { spool, collector } = setup({ config: { tracking: { git_metadata: true, agents: [] } } });
    // @ts-expect-error private
    collector.enqueue([prompt(dir)], COLLECTOR);
    expect(sent(spool).filter((e) => e.event_type === 'git.branch_changed')).toHaveLength(0);

    checkout(dir, 'feature/x');
    // @ts-expect-error private — a new scan pass
    collector.repoCache.clear();
    // @ts-expect-error private
    collector.enqueue([prompt(dir), prompt(dir)], COLLECTOR);
    const changes = sent(spool).filter((e) => e.event_type === 'git.branch_changed');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.payload).toMatchObject({ from: 'main', to: 'feature/x' });
    expect(changes[0]!.session_id).toBe('s1');
  });

  it('says nothing for an excluded project', () => {
    const dir = repo();
    const { spool, collector } = setup({
      config: { tracking: { git_metadata: true, agents: [] }, privacy: { excluded_projects: [dir] } },
    });
    // @ts-expect-error private
    collector.enqueue([prompt(dir)], COLLECTOR);
    checkout(dir, 'other');
    // @ts-expect-error private
    collector.repoCache.clear();
    // @ts-expect-error private
    collector.enqueue([prompt(dir)], COLLECTOR);
    expect(spool.depth()).toBe(0);
  });
});

describe('upload', () => {
  const heartbeat = (): EventEnvelope => ({
    event_id: randomUUID(),
    schema_version: SCHEMA_VERSION,
    occurred_at: new Date().toISOString(),
    collector_id: COLLECTOR,
    session_id: 's1',
    agent: 'codex',
    event_type: 'heartbeat',
    payload: {},
  });

  it('splits a 400 batch until only the bad event is struck', async () => {
    const events = Array.from({ length: 4 }, heartbeat);
    const bad = events[2]!.event_id;
    const { spool, collector } = setup({
      config: { upload: { batch_size: 4, concurrency: 1, max_retries: 3 } },
      sendBatch: async (batch) => {
        if (batch.some((e) => e.event_id === bad)) throw new ApiError('invalid event', 400, false);
        return ok(batch.length);
      },
    });
    spool.enqueue(events);
    await collector.scanOnce(); // fetches the org policy uploads wait for
    for (let i = 0; i < 10; i++) await collector.flush();
    expect(spool.depth()).toBe(0);
    expect(collector.uploadState().paused).toBeNull();
  });

  it('keeps the good siblings of a bad event', async () => {
    const events = Array.from({ length: 4 }, heartbeat);
    const bad = events[0]!.event_id;
    const accepted: string[] = [];
    const { spool, collector } = setup({
      config: { upload: { batch_size: 4, concurrency: 4, max_retries: 20 } },
      sendBatch: async (batch) => {
        if (batch.some((e) => e.event_id === bad)) throw new ApiError('invalid event', 422, false);
        accepted.push(...batch.map((e) => e.event_id));
        return ok(batch.length);
      },
    });
    spool.enqueue(events);
    await collector.scanOnce(); // fetches the org policy uploads wait for
    for (let i = 0; i < 6; i++) await collector.flush();
    expect(accepted.sort()).toEqual(events.slice(1).map((e) => e.event_id).sort());
    expect(spool.peek(10).map((p) => p.eventId)).toEqual([bad]);
  });

  it('clears a pause an earlier process recorded once an upload succeeds', async () => {
    const { spool, collector } = setup();
    spool.setMeta(UPLOAD_PAUSE_META, 'auth: revoked');
    spool.enqueue([heartbeat()]);
    await collector.scanOnce();
    await collector.flush();
    expect(spool.getMeta(UPLOAD_PAUSE_META)).toBeNull();
  });
});
