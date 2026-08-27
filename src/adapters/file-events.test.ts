import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeCodeAdapter, countEditLines } from './claude.js';
import { CodexAdapter, parseApplyPatch, shellFileTouches } from './codex.js';
import type { NormalizedEvent } from './types.js';

const ctx = { collectorId: '00000000-0000-4000-8000-000000000000', sourceFile: '/tmp/f.jsonl' };

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '../../test/fixtures', name), 'utf8').split('\n').filter(Boolean);

const run = (adapter: { normalize: (l: string, c: typeof ctx) => NormalizedEvent[] }, lines: string[]) =>
  lines.flatMap((l) => adapter.normalize(l, ctx));

describe('countEditLines', () => {
  it('counts a Write as every line created', () => {
    expect(countEditLines('Write', { content: 'a\nb\nc\n' })).toEqual({ lines_added: 3, lines_removed: 0 });
  });

  it('ignores lines an edit left alone', () => {
    const input = { old_string: 'keep\nold\n', new_string: 'keep\nnew\nextra\n' };
    expect(countEditLines('Edit', input)).toEqual({ lines_added: 2, lines_removed: 1 });
  });

  it('reports a pure insertion as added only', () => {
    expect(countEditLines('Edit', { old_string: '', new_string: 'one\ntwo' })).toEqual({
      lines_added: 2,
      lines_removed: 0,
    });
  });

  it('never returns NaN for a missing input', () => {
    expect(countEditLines('Edit', {})).toEqual({ lines_added: 0, lines_removed: 0 });
  });
});

describe('ClaudeCodeAdapter file.changed', () => {
  it('reports non-zero line counts for a real Edit tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 's1',
      timestamp: '2026-08-26T10:00:00.000Z',
      cwd: '/Users/dev/Web/api',
      message: {
        model: 'claude-opus-5',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Edit',
            input: {
              file_path: '/Users/dev/Web/api/src/cost.ts',
              old_string: 'const rate = 1;\nreturn rate;',
              new_string: 'const rate = 2;\nconst tax = 0.2;\nreturn rate * tax;',
            },
          },
        ],
      },
    });

    const changed = run(new ClaudeCodeAdapter(), [line]).find((e) => e.event.event_type === 'file.changed');
    expect(changed).toBeDefined();
    expect(changed!.event.payload['lines_added']).toBe(3);
    expect(changed!.event.payload['lines_removed']).toBe(2);
  });

  it('still counts the Write in the shipped fixture', () => {
    const changed = run(new ClaudeCodeAdapter(), fixture('claude-session.jsonl')).filter(
      (e) => e.event.event_type === 'file.changed',
    );
    expect(changed.length).toBeGreaterThan(0);
    expect(changed[0]!.event.payload).toHaveProperty('lines_added');
  });
});

describe('parseApplyPatch', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: README.md',
    '+# Title',
    '+',
    '*** Update File: src/app.ts',
    '@@ export function main() {',
    '-  return 1;',
    '+  return 2;',
    '+  // note',
    ' unchanged',
    '*** Delete File: old.ts',
    '*** End Patch',
  ].join('\n');

  it('splits the envelope into one entry per file with its line counts', () => {
    expect(parseApplyPatch(patch)).toEqual([
      { path: 'README.md', change_kind: 'create', lines_added: 2, lines_removed: 0 },
      { path: 'src/app.ts', change_kind: 'edit', lines_added: 2, lines_removed: 1 },
      { path: 'old.ts', change_kind: 'delete', lines_added: 0, lines_removed: 0 },
    ]);
  });

  it('returns nothing for text that is not a patch', () => {
    expect(parseApplyPatch('just some output')).toEqual([]);
  });
});

describe('shellFileTouches', () => {
  it('treats a redirect target as a write and a pager argument as a read', () => {
    expect(shellFileTouches("cat src/a.ts")).toEqual([{ event_type: 'file.read', path: 'src/a.ts' }]);
    expect(shellFileTouches('echo hi > notes.txt')).toEqual([
      { event_type: 'file.changed', path: 'notes.txt', change_kind: 'edit' },
    ]);
  });

  it('does not invent files from ordinary commands', () => {
    expect(shellFileTouches('npm test -- --watch=false')).toEqual([]);
    expect(shellFileTouches('ls -la 2> /dev/null')).toEqual([]);
  });
});

describe('CodexAdapter file events', () => {
  const meta = JSON.stringify({
    timestamp: '2026-08-26T09:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'sess-1', cwd: '/Users/dev/app', cli_version: '0.120.0' },
  });

  it('emits file.changed with line counts from an apply_patch custom_tool_call', () => {
    const call = JSON.stringify({
      timestamp: '2026-08-26T09:00:05.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'c1',
        input: '*** Begin Patch\n*** Add File: src/new.ts\n+export const x = 1;\n+export const y = 2;\n*** End Patch',
      },
    });

    const events = run(new CodexAdapter(), [meta, call]);
    const changed = events.filter((e) => e.event.event_type === 'file.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.event.payload).toMatchObject({
      path: 'src/new.ts',
      change_kind: 'create',
      lines_added: 2,
      lines_removed: 0,
    });
    // The tool call itself is still reported.
    expect(events.map((e) => e.event.event_type)).toContain('tool.started');
  });

  it('emits file.read from a shell function_call', () => {
    const call = JSON.stringify({
      timestamp: '2026-08-26T09:00:06.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'c2',
        arguments: JSON.stringify({ cmd: "sed -n '1,40p' src/app.ts", workdir: '/Users/dev/app' }),
      },
    });

    const read = run(new CodexAdapter(), [meta, call]).filter((e) => e.event.event_type === 'file.read');
    expect(read).toHaveLength(1);
    expect(read[0]!.event.payload['path']).toBe('src/app.ts');
  });

  it('never throws on an unfamiliar tool payload', () => {
    const adapter = new CodexAdapter();
    adapter.normalize(meta, ctx);
    for (const input of ['{"cmd":', 'const r = await tools.exec_command({cmd:"ls"})', '']) {
      const line = JSON.stringify({
        timestamp: '2026-08-26T09:00:07.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c3', input },
      });
      expect(() => adapter.normalize(line, ctx)).not.toThrow();
    }
  });
});
