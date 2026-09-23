import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitCommitWatcher } from './commits.js';
import type { NormalizedEvent } from '../adapters/types.js';

const repo = mkdtempSync(join(tmpdir(), 'agentstrack-commits-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });

git('init', '-q');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'Test');
writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
git('add', '.');
git('commit', '-qm', 'first');

afterAll(() => rmSync(repo, { recursive: true, force: true }));

const event = (sessionId: string, at: Date): NormalizedEvent => ({
  event: {
    occurred_at: at.toISOString(),
    session_id: sessionId,
    agent: 'claude_code',
    event_type: 'command.executed',
    payload: { command: 'git' },
  },
  cwd: repo,
});

describe('GitCommitWatcher', () => {
  it('emits git.commit for a commit made inside the session window', async () => {
    const watcher = new GitCommitWatcher();
    watcher.observe([event('sess-1', new Date(Date.now() - 60_000))]);

    const events = await watcher.poll();
    expect(events).toHaveLength(1);
    expect(events[0]!.event.event_type).toBe('git.commit');
    expect(events[0]!.event.session_id).toBe('sess-1');
    expect(String(events[0]!.event.payload['sha'])).toMatch(/^[0-9a-f]{40}$/);
    expect(events[0]!.event.payload['files_changed']).toBe(1);
    // git prints local time with an offset; the wire schema only accepts UTC.
    expect(String(events[0]!.event.payload['committed_at'])).toMatch(/Z$/);
    expect(events[0]!.event.occurred_at).toMatch(/Z$/);
  });

  it('reports each commit once, however often the repo is scanned', async () => {
    const watcher = new GitCommitWatcher();
    watcher.observe([event('sess-1', new Date(Date.now() - 60_000))]);
    expect(await watcher.poll()).toHaveLength(1);

    watcher.observe([event('sess-1', new Date(Date.now() - 60_000))]);
    expect(await watcher.poll()).toHaveLength(0);
  });

  it('gives a commit the same event id after a restart, so the server drops the repeat', async () => {
    const poll = async () => {
      const watcher = new GitCommitWatcher();
      watcher.observe([event('sess-1', new Date(Date.now() - 60_000))]);
      return (await watcher.poll())[0]!.eventId;
    };
    const first = await poll();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await poll()).toBe(first);
  });

  it('polls nothing for a repo no session touched', async () => {
    expect(await new GitCommitWatcher().poll()).toEqual([]);
  });

  it('ignores commits older than the session', async () => {
    const watcher = new GitCommitWatcher();
    watcher.observe([event('sess-2', new Date(Date.now() + 60_000))]);
    expect(await watcher.poll()).toEqual([]);
  });

  it('emits only newly-appearing commits on a later poll, not the ones already seen', async () => {
    const watcher = new GitCommitWatcher();
    watcher.observe([event('sess-3', new Date(Date.now() - 60_000))]);
    const first = await watcher.poll();
    expect(first).toHaveLength(1);
    const firstSha = String(first[0]!.event.payload['sha']);

    writeFileSync(join(repo, 'b.txt'), 'three\n');
    git('add', '.');
    git('commit', '-qm', 'second');

    watcher.observe([event('sess-3', new Date(Date.now() - 60_000))]);
    const second = await watcher.poll();
    expect(second).toHaveLength(1);
    const secondSha = String(second[0]!.event.payload['sha']);
    expect(secondSha).not.toBe(firstSha);
    expect(second[0]!.event.payload['files_changed']).toBe(1);
  });
});
