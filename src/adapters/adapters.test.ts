import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeCodeAdapter, readUsage } from './claude.js';
import { CodexAdapter, readCodexUsage } from './codex.js';
import type { NormalizedEvent } from './types.js';
import { applyPrivacy } from '../privacy/pipeline.js';
import { Config } from '../config.js';
import { SCHEMA_VERSION } from '../schema.js';

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '../../test/fixtures', name), 'utf8').split('\n').filter(Boolean);

const ctx = { collectorId: '00000000-0000-4000-8000-000000000000', sourceFile: '/tmp/f.jsonl' };

function run(adapter: { normalize: (l: string, c: typeof ctx) => NormalizedEvent[] }, lines: string[]) {
  return lines.flatMap((l) => adapter.normalize(l, ctx));
}

describe('ClaudeCodeAdapter', () => {
  const events = run(new ClaudeCodeAdapter(), fixture('claude-session.jsonl'));
  const types = events.map((e) => e.event.event_type);

  it('never throws on malformed or unknown lines', () => {
    const adapter = new ClaudeCodeAdapter();
    for (const bad of ['', '   ', 'not json', '{ broken', '{}', '{"type":"future_kind"}', 'null']) {
      expect(() => adapter.normalize(bad, ctx), bad).not.toThrow();
      expect(adapter.normalize(bad, ctx)).toEqual([]);
    }
  });

  it('extracts the human prompt and derives a title', () => {
    const prompt = events.find((e) => e.event.event_type === 'user.prompted');
    expect(prompt).toBeDefined();
    expect(prompt!.event.payload['derived_title']).toBe('Add tests for the cost calculator');
    expect(prompt!.event.payload['prompt_chars']).toBeGreaterThan(0);
  });

  it('does not treat a tool_result or slash-command markup as a human prompt', () => {
    // Two real prompts: the string one and the pasted image+text one. The
    // tool_result line and the <command-name> echo must not add more.
    const prompts = events.filter((e) => e.event.event_type === 'user.prompted');
    expect(prompts.map((p) => p.event.payload['derived_title'])).toEqual([
      'Add tests for the cost calculator',
      'Why does this test fail?',
    ]);
  });

  it('bills usage once per message.id even though each content block is its own line', () => {
    // msg_01A spans two lines (text, then tool_use) with identical usage.
    expect(types.filter((t) => t === 'model.response')).toHaveLength(2);
    // Both lines still contribute their tool blocks.
    expect(types.filter((t) => t === 'tool.started')).toHaveLength(3);
  });

  it('keys model.response on message.id, so two collectors (or a restart) agree on the event id', () => {
    const lines = fixture('claude-session.jsonl');
    const a = run(new ClaudeCodeAdapter(), lines).filter((e) => e.event.event_type === 'model.response');
    const b = run(new ClaudeCodeAdapter(), lines.slice(0, 3)).filter((e) => e.event.event_type === 'model.response');
    expect(a[0]!.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b[0]!.eventId).toBe(a[0]!.eventId);
    expect(a[1]!.eventId).not.toBe(a[0]!.eventId);
  });

  it('resolves tool_result names from the tool_use that started them', () => {
    // Real tool_result blocks carry only tool_use_id — no name.
    const done = events.find((e) => e.event.event_type === 'tool.completed');
    expect(done!.event.payload).toMatchObject({ tool_name: 'Read', tool_call_id: 't1' });
  });

  it('captures the full token breakdown including cache and thinking', () => {
    const response = events.find((e) => e.event.event_type === 'model.response');
    expect(response!.event.payload['model']).toBe('claude-opus-5');
    expect(response!.event.payload['usage']).toMatchObject({
      input_tokens: 2,
      cache_creation_input_tokens: 39728,
      cached_input_tokens: 26254,
      output_tokens: 505,
      reasoning_output_tokens: 257,
    });
  });

  it('emits tool, file and command events from content blocks', () => {
    expect(types).toContain('tool.started');
    expect(types).toContain('file.read');
    expect(types).toContain('file.changed');
    expect(types).toContain('command.executed');
    const cmd = events.find((e) => e.event.event_type === 'command.executed');
    expect(cmd!.event.payload['command']).toContain('vitest');
  });

  it('names what Skill, Agent and Workflow calls invoked — never the prompt or the script', () => {
    const assists = run(new ClaudeCodeAdapter(), fixture('claude-assists.jsonl'));
    const started = assists.filter((e) => e.event.event_type === 'tool.started').map((e) => e.event.payload);
    expect(started).toEqual([
      expect.objectContaining({ tool_name: 'Skill', skill: 'artifact-design' }),
      expect.objectContaining({ tool_name: 'Agent', subagent_type: 'payment-integration', description: 'Finish Stripe billing' }),
      expect.objectContaining({ tool_name: 'Workflow', workflow_name: 'agentstrack-marketing-site' }),
    ]);
    for (const p of started) {
      expect(p).not.toHaveProperty('prompt');
      expect(p).not.toHaveProperty('script');
      expect(p).not.toHaveProperty('sidechain');
    }
    // The extras ride on the terminal event too, which is what the server counts.
    const done = assists.filter((e) => e.event.event_type === 'tool.completed').map((e) => e.event.payload);
    expect(done).toEqual([
      expect.objectContaining({ tool_name: 'Agent', subagent_type: 'payment-integration' }),
      expect.objectContaining({ tool_name: 'Skill', skill: 'artifact-design' }),
    ]);
  });

  it('flags an ultracode prompt as a whole word, and the flag survives metadata mode', () => {
    const prompts = run(new ClaudeCodeAdapter(), fixture('claude-assists.jsonl')).filter(
      (e) => e.event.event_type === 'user.prompted',
    );
    expect(prompts.map((p) => p.event.payload['ultracode'])).toEqual([true, undefined]);
    const { event } = applyPrivacy(
      { ...prompts[0]!.event, event_id: ctx.collectorId, collector_id: ctx.collectorId, schema_version: SCHEMA_VERSION },
      { config: Config.parse({ privacy: { mode: 'metadata' } }) },
    );
    expect(event.payload).toMatchObject({ ultracode: true });
    expect(event.payload).not.toHaveProperty('prompt_text');
  });

  it('stamps every event from a sub-agent transcript with its identity, from the path and meta file', () => {
    const dir = join(import.meta.dirname, '../../test/fixtures/06f3470f-d924-4552-b3ee-3f8924286cec/subagents');
    const adapter = new ClaudeCodeAdapter();
    const at = (file: string) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => adapter.normalize(l, { ...ctx, sourceFile: file }));

    const sub = at(join(dir, 'agent-x.jsonl'));
    expect(sub.map((e) => e.event.event_type)).toEqual(['user.prompted', 'model.response', 'tool.started', 'file.read', 'tool.completed']);
    for (const e of sub) {
      expect(e.event.session_id).toBe('06f3470f-d924-4552-b3ee-3f8924286cec');
      expect(e.event.payload).toMatchObject({ sidechain: true, agent_id: 'x', agent_kind: 'subagent', agent_type: 'payment-integration' });
    }
    // The sub-agent's own usage is what the server attributes to the agent.
    expect(sub[1]!.event.payload['usage']).toMatchObject({ cache_creation_input_tokens: 38833, output_tokens: 120 });

    const wf = at(join(dir, 'workflows/wf_1/agent-y.jsonl'));
    expect(wf).toHaveLength(1);
    expect(wf[0]!.event.payload).toMatchObject({ sidechain: true, agent_id: 'y', agent_kind: 'workflow', agent_type: 'workflow-subagent' });
  });

  it('carries repo context through', () => {
    expect(events[0]!.repo?.branch).toBe('feature/pricing');
    expect(events[0]!.cwd).toBe('/Users/dev/Web/api');
  });
});

describe('CodexAdapter', () => {
  const events = run(new CodexAdapter(), fixture('codex-session.jsonl'));
  const types = events.map((e) => e.event.event_type);

  it('never throws on malformed or unknown lines', () => {
    const adapter = new CodexAdapter();
    for (const bad of ['', 'not json', '{ broken', '{}', '{"type":"unknown_kind","timestamp":"2026-01-01T00:00:00Z"}']) {
      expect(() => adapter.normalize(bad, ctx)).not.toThrow();
    }
  });

  it('starts the session from session_meta and carries the id to later lines', () => {
    expect(types[0]).toBe('session.started');
    const ids = new Set(events.map((e) => e.event.session_id));
    expect(ids).toEqual(new Set(['019d94f1-c8eb-7582-9345-71eace2149f6']));
  });

  it('ignores lines that arrive before session_meta', () => {
    const adapter = new CodexAdapter();
    const orphan = adapter.normalize(
      '{"timestamp":"2026-08-26T09:00:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
      { ...ctx, sourceFile: '/tmp/other.jsonl' },
    );
    expect(orphan).toEqual([]);
  });

  it('recovers the session id from the rollout file name after a restart', () => {
    // session_meta was consumed before the daemon restarted; the file name
    // carries the same uuid, so later lines must not be dropped.
    const adapter = new CodexAdapter();
    const lines = fixture('codex-session.jsonl');
    const sourceFile = '/tmp/rollout-2026-08-26T09-00-00-019d94f1-c8eb-7582-9345-71eace2149f6.jsonl';
    const usage = adapter.normalize(lines[8]!, { ...ctx, sourceFile });
    expect(usage.map((e) => e.event.event_type)).toEqual(['usage.reported']);
    expect(usage[0]!.event.session_id).toBe('019d94f1-c8eb-7582-9345-71eace2149f6');
  });

  it('picks up the model from turn_context', () => {
    const usage = events.find((e) => e.event.event_type === 'usage.reported');
    expect(usage!.event.payload['model']).toBe('gpt-5.4');
  });

  it('marks token_count as cumulative so the server does not sum snapshots', () => {
    const usages = events.filter((e) => e.event.event_type === 'usage.reported');
    expect(usages).toHaveLength(2);
    for (const u of usages) expect(u.event.payload['cumulative']).toBe(true);
    // Second snapshot supersedes the first — 90000 input of which 60000 cached.
    expect(usages[1]!.event.payload['usage']).toMatchObject({ input_tokens: 30000, cached_input_tokens: 60000 });
  });

  it('flags a subscription plan so cost is reported as an estimate', () => {
    const usage = events.find((e) => e.event.event_type === 'usage.reported');
    expect(usage!.event.payload['plan_type']).toBe('plus');
  });

  it('terminates exec_command on exec_command_end with the real argv, exit code and duration', () => {
    const c1 = events.filter((e) => e.event.payload['tool_call_id'] === 'c1').map((e) => e.event.event_type);
    // One start, one terminal — the function_call_output must not add a second.
    expect(c1).toEqual(['tool.started', 'tool.completed']);
    const cmd = events.find((e) => e.event.event_type === 'command.executed');
    expect(cmd!.event.payload).toMatchObject({ command: 'npm test', exit_code: 0, duration_ms: 1500 });
  });

  it('reads the exit status off the shell_command output header', () => {
    const failed = events.find((e) => e.event.event_type === 'tool.failed');
    expect(failed!.event.payload).toMatchObject({ tool_name: 'shell_command', tool_call_id: 'c2' });
  });

  it('keeps per-file state separate so two rollouts do not bleed together', () => {
    const adapter = new CodexAdapter();
    const lines = fixture('codex-session.jsonl');
    adapter.normalize(lines[0]!, { ...ctx, sourceFile: '/tmp/a.jsonl' });
    const fromB = adapter.normalize(lines[2]!, { ...ctx, sourceFile: '/tmp/b.jsonl' });
    expect(fromB).toEqual([]); // b never saw a session_meta
  });
});

describe('usage mapping', () => {
  it('treats reasoning/thinking tokens as a subset of output, never additive', () => {
    const claude = readUsage({ output_tokens: 1000, output_tokens_details: { thinking_tokens: 900 } });
    expect(claude.output_tokens).toBe(1000);
    expect(claude.reasoning_output_tokens).toBe(900);

    const codex = readCodexUsage({ output_tokens: 500, reasoning_output_tokens: 400 });
    expect(codex.output_tokens).toBe(500);
    expect(codex.reasoning_output_tokens).toBe(400);
  });

  it('treats Codex cached_input_tokens as a subset of input_tokens, never additive', () => {
    const codex = readCodexUsage({ input_tokens: 50000, cached_input_tokens: 30000 });
    expect(codex).toMatchObject({ input_tokens: 20000, cached_input_tokens: 30000 });
  });

  it('defaults missing fields to zero rather than NaN', () => {
    for (const u of [readUsage(undefined), readCodexUsage(null), readUsage({})]) {
      for (const value of Object.values(u)) expect(Number.isFinite(value)).toBe(true);
    }
  });
});
