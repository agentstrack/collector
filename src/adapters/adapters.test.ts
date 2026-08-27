import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeCodeAdapter, readUsage } from './claude.js';
import { CodexAdapter, readCodexUsage } from './codex.js';
import type { NormalizedEvent } from './types.js';

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

  it('does not treat a tool_result as a human prompt', () => {
    // The fixture has one real prompt; the tool_result line must not add another.
    expect(types.filter((t) => t === 'user.prompted')).toHaveLength(1);
    expect(types).toContain('tool.completed');
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

  it('picks up the model from turn_context', () => {
    const usage = events.find((e) => e.event.event_type === 'usage.reported');
    expect(usage!.event.payload['model']).toBe('gpt-5.4');
  });

  it('marks token_count as cumulative so the server does not sum snapshots', () => {
    const usages = events.filter((e) => e.event.event_type === 'usage.reported');
    expect(usages).toHaveLength(2);
    for (const u of usages) expect(u.event.payload['cumulative']).toBe(true);
    // Second snapshot supersedes the first — 90000, not 140000.
    expect((usages[1]!.event.payload['usage'] as { input_tokens: number }).input_tokens).toBe(90000);
  });

  it('flags a subscription plan so cost is reported as an estimate', () => {
    const usage = events.find((e) => e.event.event_type === 'usage.reported');
    expect(usage!.event.payload['plan_type']).toBe('plus');
  });

  it('normalizes function calls into tool events', () => {
    expect(types).toContain('tool.started');
    expect(types).toContain('tool.completed');
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

  it('defaults missing fields to zero rather than NaN', () => {
    for (const u of [readUsage(undefined), readCodexUsage(null), readUsage({})]) {
      for (const value of Object.values(u)) expect(Number.isFinite(value)).toBe(true);
    }
  });
});
