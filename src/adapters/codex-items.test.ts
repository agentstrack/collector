import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAdapter, fileChangeTouches, rolloutFormat } from './codex.js';
import type { NormalizedEvent } from './types.js';
import { applyPrivacy } from '../privacy/pipeline.js';
import { Config } from '../config.js';
import { SCHEMA_VERSION } from '../schema.js';

// Codex ≥0.15x rollouts: item_completed instead of user_message/exec_command_end,
// and per-response token_usage_record lines. Fixtures are synthetic.
const fixturePath = (name: string) => join(import.meta.dirname, '../../test/fixtures', name);
const fixture = (name: string) => readFileSync(fixturePath(name), 'utf8').split('\n').filter(Boolean);
const ctx = { collectorId: '00000000-0000-4000-8000-000000000000', sourceFile: '/tmp/no-such-rollout.jsonl' };

function run(lines: string[], sourceFile = ctx.sourceFile): NormalizedEvent[] {
  const adapter = new CodexAdapter();
  return lines.flatMap((l) => adapter.normalize(l, { ...ctx, sourceFile }));
}
const ofType = (events: NormalizedEvent[], t: string) => events.filter((e) => e.event.event_type === t);

describe('CodexAdapter, item_completed rollouts', () => {
  const events = run(fixture('codex-session-v2.jsonl'));

  it('takes prompts from UserMessage items, one per item, and not from response_item messages', () => {
    const prompts = ofType(events, 'user.prompted');
    expect(prompts.map((p) => p.event.payload['derived_title'])).toEqual([
      'Fix the failing date parser test',
      'Now run the whole suite',
      'and lint too',
    ]);
    expect(prompts[0]!.event.payload['prompt_chars']).toBe('Fix the failing date parser test'.length);
  });

  it('bills each response once, as a counter, under the model that served it', () => {
    const usage = ofType(events, 'usage.reported');
    // r1 appears twice in the fixture; the duplicate is dropped. No gauge at all.
    expect(usage).toHaveLength(2);
    for (const u of usage) expect(u.event.payload['cumulative']).toBe(false);
    expect(usage.map((u) => u.event.payload['model'])).toEqual(['gpt-6-luna', 'gpt-6.1-sol']);
    expect(usage[0]!.event.payload['usage']).toMatchObject({ input_tokens: 6000, cached_input_tokens: 4000, output_tokens: 500 });
    expect(usage[1]!.event.payload['usage']).toMatchObject({ input_tokens: 5000, cached_input_tokens: 15000, output_tokens: 800 });
    // Summed per model, nothing overlaps: the thread total is 30000 input (19000 cached).
    const input = usage.reduce((s, u) => s + (u.event.payload['usage'] as { input_tokens: number }).input_tokens, 0);
    const cached = usage.reduce((s, u) => s + (u.event.payload['usage'] as { cached_input_tokens: number }).cached_input_tokens, 0);
    expect(input + cached).toBe(30000);
    expect(cached).toBe(19000);
  });

  it('carries the plan from the last token_count onto later records', () => {
    const usage = ofType(events, 'usage.reported');
    expect(usage[1]!.event.payload['plan_type']).toBe('plus');
  });

  it('reports commands from CommandExecution items, with shell file reads', () => {
    expect(ofType(events, 'command.executed').map((e) => e.event.payload)).toEqual([
      { command: 'cat src/date.ts', exit_code: 0, duration_ms: 250 },
    ]);
    expect(ofType(events, 'file.read').map((e) => e.event.payload['path'])).toEqual(['src/date.ts']);
  });

  it('counts FileChange lines locally and never puts the file body in an event', () => {
    const changed = ofType(events, 'file.changed').map((e) => e.event.payload);
    expect(changed).toEqual([
      { path: '/Users/dev/Web/api/src/date.ts', change_kind: 'edit', lines_added: 2, lines_removed: 1 },
      { path: '/Users/dev/Web/api/src/date.test.ts', change_kind: 'create', lines_added: 3, lines_removed: 0 },
    ]);
  });

  it('records MCP calls, which have no response_item line', () => {
    const mcp = events.find((e) => e.event.payload['tool_name'] === 'mcp__github__get_issue');
    expect(mcp!.event.event_type).toBe('tool.completed');
    expect(mcp!.event.payload).toMatchObject({ tool_call_id: 'm1', duration_ms: 400 });
  });

  it('keeps tool start/finish from the response_item exec call', () => {
    const x1 = events.filter((e) => e.event.payload['tool_call_id'] === 'x1').map((e) => e.event.event_type);
    expect(x1).toEqual(['tool.started', 'tool.completed']);
  });

  it('ends completed and aborted turns with their duration', () => {
    const ended = ofType(events, 'agent.turn.ended').map((e) => e.event.payload);
    expect(ended).toEqual([
      { turn_id: 't1', duration_ms: 6000 },
      { turn_id: 't2', duration_ms: 3000, aborted: true, abort_reason: 'interrupted' },
    ]);
  });

  it('emits no gauge when the daemon resumes mid-file past the first record', () => {
    // Fresh adapter, first line seen is a token_count: the file scan must
    // already know this rollout is billed per response.
    const lines = fixture('codex-session-v2.jsonl');
    const resumeAt = lines.findIndex((l) => l.includes('"type":"token_count"'));
    const tail = run(lines.slice(resumeAt), fixturePath('codex-session-v2.jsonl'));
    expect(ofType(tail, 'usage.reported').every((u) => u.event.payload['cumulative'] === false)).toBe(true);
  });

  it('drops prompt text in metadata mode like any other prompt', () => {
    const prompt = ofType(events, 'user.prompted')[0]!;
    const { event } = applyPrivacy(
      { ...prompt.event, event_id: ctx.collectorId, collector_id: ctx.collectorId, schema_version: SCHEMA_VERSION },
      { config: Config.parse({ privacy: { mode: 'metadata' } }) },
    );
    expect(event.payload).not.toHaveProperty('prompt_text');
  });
});

describe('CodexAdapter, forked and multi-agent threads', () => {
  const events = run(fixture('codex-fork-v2.jsonl'));

  it('links the child to the thread it was forked from', () => {
    expect(ofType(events, 'session.started')[0]!.event.payload['parent_session_id']).toBe(
      '01a20000-0000-7000-8000-000000000001',
    );
  });

  it("bills only the child's own responses, not the parent history it inherits", () => {
    const usage = ofType(events, 'usage.reported');
    expect(usage).toHaveLength(1);
    // thread_token_usage says 35000 input; 30000 of it is the parent's.
    expect(usage[0]!.event.payload['usage']).toMatchObject({ input_tokens: 4000, cached_input_tokens: 1000, output_tokens: 100 });
  });
});

describe('rolloutFormat / fileChangeTouches', () => {
  it('reads the format off the whole file and treats a missing file as legacy', () => {
    expect(rolloutFormat(fixturePath('codex-session-v2.jsonl'))).toEqual({ usageFromRecords: true, itemMode: true });
    expect(rolloutFormat(fixturePath('codex-session.jsonl'))).toEqual({ usageFromRecords: false, itemMode: false });
    expect(rolloutFormat('/nonexistent/rollout.jsonl')).toEqual({ usageFromRecords: false, itemMode: false });
  });

  it('tolerates unknown or malformed change shapes', () => {
    expect(fileChangeTouches(null)).toEqual([]);
    expect(fileChangeTouches([])).toEqual([]);
    expect(fileChangeTouches({ '/a': { type: 'delete', content: 'x\ny\n' } })).toEqual([
      { event_type: 'file.changed', path: '/a', change_kind: 'delete', lines_added: 0, lines_removed: 2 },
    ]);
    expect(fileChangeTouches({ '/b': { type: 'update' } })).toEqual([
      { event_type: 'file.changed', path: '/b', change_kind: 'edit' },
    ]);
  });
});
