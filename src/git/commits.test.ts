import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * B1: excluded projects must never leak commits. Two paths: an excluded
 * session (observed before the exclusion filter ran), and an excluded subfolder
 * sharing a repo root with an allowed session. Each test gets its own repo so
 * the 60-second session window cannot pick up another test's commits.
 */
describe('GitCommitWatcher exclusions', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  function monorepo() {
    const dir = mkdtempSync(join(tmpdir(), 'agentstrack-mono-'));
    dirs.push(dir);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    mkdirSync(join(dir, 'secret'));
    mkdirSync(join(dir, 'public'));
    writeFileSync(join(dir, 'public', 'a.txt'), 'a\n');
    writeFileSync(join(dir, 'secret', 'b.txt'), 'b\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    return {
      dir,
      secret: join(dir, 'secret'),
      publicDir: join(dir, 'public'),
      git,
    };
  }

  const ev = (sessionId: string, cwd: string): NormalizedEvent => ({
    event: {
      occurred_at: new Date(Date.now() - 60_000).toISOString(),
      session_id: sessionId,
      agent: 'claude_code',
      event_type: 'command.executed',
      payload: { command: 'git' },
    },
    cwd,
  });

  it('reports nothing from a session whose cwd is excluded, even for a commit outside the excluded path', async () => {
    const m = monorepo();
    const watcher = new GitCommitWatcher({ excluded: [m.secret] });
    watcher.observe([ev('sess-x', m.secret), ev('sess-x', join(m.secret, 'deep'))]);
    writeFileSync(join(m.publicDir, 'a.txt'), 'public change\n');
    m.git('commit', '-qam', 'public change made from the excluded session');
    expect(await watcher.poll()).toEqual([]);
  });

  it('does not report a commit that touches an excluded subfolder under an allowed session', async () => {
    const m = monorepo();
    const watcher = new GitCommitWatcher({ excluded: [m.secret] });
    watcher.observe([ev('sess-allowed', m.publicDir)]);

    writeFileSync(join(m.secret, 'b.txt'), 'changed\n');
    m.git('commit', '-qam', 'touch excluded only');
    writeFileSync(join(m.publicDir, 'a.txt'), 'changed\n');
    writeFileSync(join(m.secret, 'b.txt'), 'changed again\n');
    m.git('commit', '-qam', 'touch both');

    expect(await watcher.poll()).toEqual([]);
  });

  it('still reports an allowed commit in the same repo', async () => {
    const m = monorepo();
    const watcher = new GitCommitWatcher({ excluded: [m.secret] });
    watcher.observe([ev('sess-allowed', m.publicDir)]);

    writeFileSync(join(m.publicDir, 'a.txt'), 'public change\n');
    m.git('commit', '-qam', 'public only');
    const events = await watcher.poll();
    expect(events).toHaveLength(1);
    expect(events[0]!.event.payload['files_changed']).toBe(1);
  });
});
