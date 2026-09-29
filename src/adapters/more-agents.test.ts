import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AntigravityAdapter } from './antigravity.js';
import { GeminiCliAdapter, readGeminiTokens } from './gemini.js';
import { KimiCodeAdapter, defaultModel } from './kimi.js';
import { readCodexAccount, readGeminiAccount, resetAccountCache } from './account.js';
import type { NormalizedEvent, PollContext } from './types.js';
import { listTranscripts } from '../daemon.js';
import { applyPrivacy } from '../privacy/pipeline.js';
import { Config } from '../config.js';
import { SCHEMA_VERSION } from '../schema.js';
import { AGY_CONVERSATION, AGY_EMAIL, AGY_MODEL, AGY_T0, seedAntigravityFixture } from '../../test/fixtures/antigravity-db.js';

const FIXTURES = join(import.meta.dirname, '../../test/fixtures');
const collectorId = '00000000-0000-4000-8000-000000000000';
const byType = (events: NormalizedEvent[], type: string) => events.filter((e) => e.event.event_type === type);
const lines = (path: string) => readFileSync(path, 'utf8').split('\n');

function pollContext(): PollContext {
  const store = new Map<string, string>();
  return { collectorId, getMeta: (k) => store.get(k) ?? null, setMeta: (k, v) => void store.set(k, v) };
}

/** What would leave the machine in metadata mode. */
const metadataOnly = (e: NormalizedEvent) =>
  applyPrivacy(
    { ...e.event, event_id: '00000000-0000-4000-8000-000000000001', collector_id: collectorId, schema_version: SCHEMA_VERSION },
    { config: Config.parse({ privacy: { mode: 'metadata' } }) },
  ).event.payload;

describe('AntigravityAdapter', () => {
  let dir: string;
  let adapter: AntigravityAdapter;
  let ctx: PollContext;
  let first: NormalizedEvent[];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentstrack-agy-test-'));
    seedAntigravityFixture(dir);
    resetAccountCache();
    adapter = new AntigravityAdapter(dir, 3650);
    ctx = pollContext();
    first = await adapter.poll(ctx);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reconstructs the session, prompt, model call and tools from the protobuf steps', () => {
    const started = byType(first, 'session.started')[0]!;
    expect(started.event.session_id).toBe(AGY_CONVERSATION);
    expect(started.event.occurred_at).toBe(new Date(AGY_T0).toISOString());
    expect(started.cwd).toBe('/work/agy-project');
    expect(started.repo).toEqual({ project_path: '/work/agy-project', branch: 'feature/x' });

    expect(byType(first, 'user.prompted')[0]!.event.payload['prompt_chars']).toBe('Synthetic prompt: add a flag'.length);

    const response = byType(first, 'model.response')[0]!.event.payload;
    expect(response['model']).toBe(AGY_MODEL);
    // input excludes cache reads; output already includes the 200 thinking tokens.
    expect(response['usage']).toMatchObject({ input_tokens: 1000, cached_input_tokens: 500, output_tokens: 300, reasoning_output_tokens: 200 });

    expect(byType(first, 'tool.completed').map((e) => e.event.payload['tool_name'])).toEqual(['run_command', 'view_file']);
    expect(byType(first, 'tool.completed')[0]!.event.payload['duration_ms']).toBe(1500);
    expect(byType(first, 'command.executed')[0]!.event.payload['command']).toBe('npm test');
    expect(byType(first, 'tool.failed')[0]!.event.payload['tool_name']).toBe('replace_file_content');
    expect(byType(first, 'file.changed')[0]!.event.payload).toMatchObject({ lines_added: 2, lines_removed: 1 });
    // The model's own prose about each call never becomes a field.
    expect(JSON.stringify(first)).not.toContain('Made-up prose');
    // In-flight step 4 produced nothing yet.
    expect(byType(first, 'file.read').map((e) => e.event.payload['path'])).toEqual(['/work/agy-project/src/c.ts']);
  });

  it('never touches the live database directory', () => {
    expect(readdirSync(join(dir, 'conversations'))).toEqual([`${AGY_CONVERSATION}.db`]);
  });

  it('skips an unchanged conversation and resumes before the step that was still running', async () => {
    expect(await adapter.poll(ctx)).toEqual([]);

    const path = join(dir, 'conversations', `${AGY_CONVERSATION}.db`);
    const db = new Database(path);
    db.prepare('UPDATE steps SET status = 3 WHERE idx = 4').run();
    db.close();
    utimesSync(path, new Date(), new Date(Date.now() + 5000));

    const second = await adapter.poll(ctx);
    expect(byType(second, 'session.started')).toEqual([]);
    expect(byType(second, 'file.read').map((e) => e.event.payload['path'])).toEqual([
      '/work/agy-project/src/b.ts',
      '/work/agy-project/src/c.ts',
    ]);
    // The re-read step 5 dedupes on the same event id.
    const c = (events: NormalizedEvent[]) => byType(events, 'file.read').find((e) => String(e.event.payload['path']).endsWith('c.ts'))!.eventId;
    expect(c(second)).toBe(c(first));
  });

  it('attributes the account from the sign-in log line, keyed by a hash, never the email', () => {
    const account = adapter.account();
    expect(account?.label).toBe(AGY_EMAIL);
    expect(account?.key).toMatch(/^google:[0-9a-f]{32}$/);
  });

  it('drops the prompt text in metadata mode', () => {
    const payload = metadataOnly(byType(first, 'user.prompted')[0]!);
    expect(payload['prompt_text']).toBeUndefined();
    expect(payload['prompt_chars']).toBeGreaterThan(0);
  });
});

describe('GeminiCliAdapter', () => {
  const home = join(FIXTURES, 'gemini-home');
  const file = join(home, 'tmp/myproj/chats/session-2026-09-24T08-53-9e000000.jsonl');
  const ctx = { collectorId, sourceFile: file };
  const events = lines(file).flatMap((l) => new GeminiCliAdapter(home).normalize(l, ctx));
  const unique = (type: string) => new Set(byType(events, type).map((e) => e.eventId)).size;

  it('reads the session, its project root and the prompt', () => {
    const started = byType(events, 'session.started')[0]!;
    expect(started.event.session_id).toBe('9e000000-0000-4000-8000-0000000000a1');
    expect(started.cwd).toBe('/work/gemini-project');
    expect(unique('user.prompted')).toBe(1);
  });

  it('bills a re-appended or $set-rewritten message once, with Gemini token semantics', () => {
    expect(unique('model.response')).toBe(1);
    expect(byType(events, 'model.response')[0]!.event.payload['usage']).toEqual(
      readGeminiTokens({ input: 1200, output: 80, cached: 1000, thoughts: 50, tool: 0 }),
    );
    expect(readGeminiTokens({ input: 1200, output: 80, cached: 1000, thoughts: 50, tool: 0 })).toMatchObject({
      input_tokens: 200, cached_input_tokens: 1000, output_tokens: 130, reasoning_output_tokens: 50,
    });
  });

  it('emits terminal tool calls only, with their command and file effects', () => {
    expect(byType(events, 'tool.completed').map((e) => e.event.payload['tool_name'])).toEqual(['run_shell_command', 'write_file']);
    expect(byType(events, 'tool.failed').map((e) => e.event.payload['tool_name'])).toEqual(['replace']);
    expect(byType(events, 'command.executed')[0]!.event.payload['command']).toBe('npm test');
    expect(byType(events, 'file.changed').map((e) => e.event.payload['lines_added'])).toEqual([2, 1]);
    expect(byType(events, 'file.read')).toEqual([]); // tc4 is still executing
    expect(JSON.stringify(events)).not.toContain('made-up output');
  });

  it('recovers the session id after a restart mid-file', () => {
    const resumed = new GeminiCliAdapter(home).normalize(lines(file)[1]!, ctx);
    expect(resumed[0]?.event.session_id).toBe('9e000000-0000-4000-8000-0000000000a1');
  });

  it('reads the active Google account as a hashed key', () => {
    resetAccountCache();
    const account = readGeminiAccount(home);
    expect(account).toMatchObject({ label: 'dev@example.com', provider: 'google' });
    expect(account?.key).not.toContain('@');
  });
});

describe('KimiCodeAdapter (format from upstream source)', () => {
  const home = join(FIXTURES, 'kimi-home');
  const session = join(home, 'sessions/aaec326b87de6c65cbc919cff0fa048e/4b000000-0000-4000-8000-0000000000c1');
  const run = (file: string) => {
    const adapter = new KimiCodeAdapter(home);
    return lines(file).flatMap((l) => adapter.normalize(l, { collectorId, sourceFile: file }));
  };
  const events = run(join(session, 'wire.jsonl'));

  it('maps the session to its work dir and the model to config.toml', () => {
    const started = byType(events, 'session.started')[0]!;
    expect(started.event.session_id).toBe('4b000000-0000-4000-8000-0000000000c1');
    expect(started.cwd).toBe('/work/kimi-project');
    expect(defaultModel(home)).toBe('kimi-for-coding');
  });

  it('bills per-step usage, including a subagent step relayed through the parent', () => {
    const usage = byType(events, 'model.response').map((e) => e.event.payload['usage']);
    expect(usage).toEqual([
      expect.objectContaining({ input_tokens: 900, cached_input_tokens: 4000, output_tokens: 120 }),
      expect.objectContaining({ input_tokens: 100, output_tokens: 10 }),
    ]);
    expect(byType(events, 'model.response')[1]!.event.payload['sidechain']).toBe(true);
  });

  it('pairs tool calls with results and counts multi-edit lines', () => {
    expect(byType(events, 'tool.completed')[0]!.event.payload).toMatchObject({ tool_name: 'Shell', duration_ms: 2000 });
    expect(byType(events, 'tool.failed')[0]!.event.payload['tool_name']).toBe('StrReplaceFile');
    expect(byType(events, 'file.changed')[0]!.event.payload).toMatchObject({ lines_added: 2, lines_removed: 1 });
    expect(byType(events, 'agent.turn.ended')).toHaveLength(1);
  });

  it('ignores context.jsonl and the duplicated subagent wire file', () => {
    expect(run(join(session, 'context.jsonl'))).toEqual([]);
    expect(run(join(session, 'subagents/sa1/wire.jsonl'))).toEqual([]);
  });
});

describe('readCodexAccount', () => {
  it('keys on account_id, decodes only the id_token payload, and keeps no token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentstrack-codex-auth-'));
    try {
      const claims = { email: 'dev@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct-1' } };
      const idToken = `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
      writeFileSync(
        join(dir, 'auth.json'),
        JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: idToken, access_token: 'SECRET-A', refresh_token: 'SECRET-R', account_id: 'acct-1' } }),
      );
      resetAccountCache();
      const account = readCodexAccount(dir);
      expect(account).toEqual({ key: 'acct-1', label: 'dev@example.com', provider: 'openai', planType: 'plus' });
      expect(JSON.stringify(account)).not.toMatch(/SECRET|e30/);

      writeFileSync(join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'SECRET-K', tokens: null }));
      utimesSync(join(dir, 'auth.json'), new Date(), new Date(Date.now() + 5000));
      expect(readCodexAccount(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('listTranscripts', () => {
  it('walks each real directory once, even through a self-referential symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentstrack-walk-'));
    try {
      mkdirSync(join(dir, 'proj'));
      writeFileSync(join(dir, 'proj', 's.jsonl'), '{}\n');
      symlinkSync(dir, join(dir, 'projects')); // projects -> .
      expect(listTranscripts(dir, 3650)).toEqual([join(dir, 'proj', 's.jsonl')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
