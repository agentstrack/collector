import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { RepoContext } from '../schema.js';

const exec = promisify(execFile);

/**
 * Git enrichment.
 *
 * Branch and remote are read straight out of .git — two file reads beat
 * spawning a process per event. `git log` is only shelled out for diffstats,
 * which cannot be read from a file.
 *
 * The remote URL is never transmitted: only a SHA-256 of its normalized form,
 * which is enough to correlate a repo across machines without disclosing it.
 */
export function findGitRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function readBranch(gitRoot: string): string | undefined {
  try {
    const head = readFileSync(join(gitRoot, '.git', 'HEAD'), 'utf8').trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    // A detached HEAD holds a raw SHA and has no branch name.
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function readRemote(gitRoot: string): string | undefined {
  try {
    const config = readFileSync(join(gitRoot, '.git', 'config'), 'utf8');
    // Prefer origin; fall back to the first remote defined.
    const origin = /\[remote "origin"\][^[]*?url\s*=\s*(.+)/s.exec(config);
    if (origin?.[1]) return origin[1].split('\n')[0]!.trim();
    const any = /\[remote "[^"]+"\][^[]*?url\s*=\s*(.+)/s.exec(config);
    return any?.[1]?.split('\n')[0]?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Collapses ssh and https forms of one repository onto a single identity, so
 * the same repo cloned two ways still correlates. Mirrors the server's
 * normalizeRemote — they must agree or nothing matches.
 */
export function normalizeRemote(remote: string): string {
  let s = remote.trim().replace(/\.git$/, '').replace(/^git\+/, '');
  const ssh = /^(?:ssh:\/\/)?(?:[^@]+@)?([^:/]+)[:/](.+)$/.exec(s);
  if (ssh && !s.startsWith('http')) return `${ssh[1]!.toLowerCase()}/${ssh[2]!.toLowerCase()}`;
  try {
    const u = new URL(s);
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/$/, '').toLowerCase()}`;
  } catch {
    return s.toLowerCase();
  }
}

export function hashRemote(remote: string): string {
  return createHash('sha256').update(normalizeRemote(remote)).digest('hex');
}

/** owner/name parsed out of a normalized remote, for display only. */
export function ownerAndName(remote: string): { owner?: string; name?: string } {
  const parts = normalizeRemote(remote).split('/');
  if (parts.length < 3) return {};
  return { owner: parts[parts.length - 2], name: parts[parts.length - 1] };
}

export function describeRepo(cwd: string): RepoContext | undefined {
  const root = findGitRoot(cwd);
  if (!root) return { project_path: cwd, project_name: basename(cwd) };

  const remote = readRemote(root);
  const context: RepoContext = {
    branch: readBranch(root),
    project_path: root,
    project_name: basename(root),
  };
  if (remote) {
    context.remote_hash = hashRemote(remote);
    const { owner, name } = ownerAndName(remote);
    context.remote_owner = owner;
    context.remote_name = name;
  }
  return context;
}

/**
 * git prints local time with an offset; the wire schema only accepts UTC, so an
 * un-normalized timestamp gets the whole event rejected at ingest.
 */
function toUtcIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** A commit's identity and time, without the (more expensive) diffstat. */
export interface CommitRef {
  sha: string;
  committedAt: string;
}

/**
 * The SHAs authored in this repo within a time window — cheap: no diff is
 * computed. The caller filters out already-seen SHAs before asking for stats,
 * so `git show --numstat` runs only for genuinely new commits rather than
 * re-diffing the whole window on every poll.
 */
export async function commitShasSince(gitRoot: string, since: Date): Promise<CommitRef[]> {
  try {
    const { stdout } = await exec(
      'git',
      ['log', `--since=${since.toISOString()}`, '--format=%H%x00%cI', '--no-merges'],
      { cwd: gitRoot, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const refs: CommitRef[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.includes('\0')) continue;
      const [sha, committedAt] = line.split('\0');
      if (!sha) continue;
      refs.push({ sha, committedAt: toUtcIso(committedAt) ?? since.toISOString() });
    }
    return refs;
  } catch {
    // No git binary, not a repo, or a timeout — enrichment is best-effort.
    return [];
  }
}

/** Diffstat for a single commit. */
export async function commitStat(
  gitRoot: string,
  sha: string,
): Promise<{ additions: number; deletions: number; filesChanged: number }> {
  const stat = { additions: 0, deletions: 0, filesChanged: 0 };
  try {
    const { stdout } = await exec(
      'git',
      ['show', '--numstat', '--format=', '--no-merges', sha],
      { cwd: gitRoot, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [added, removed] = line.split('\t');
      // Binary files show '-' rather than a count.
      stat.additions += Number(added) || 0;
      stat.deletions += Number(removed) || 0;
      stat.filesChanged += 1;
    }
  } catch {
    // Best-effort: a commit with no readable diff still reports zeros.
  }
  return stat;
}
