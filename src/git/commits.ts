import type { NormalizedEvent } from '../adapters/types.js';
import { commitsSince, findGitRoot } from './repo.js';

/**
 * Emits `git.commit` for commits that land while a session is running.
 *
 * This is the only EXACT signal the server has for tying a session to a pull
 * request (BLUEPRINT §13), and no agent writes it to its transcript — the
 * commit is made by a shell command whose output we never see. So the
 * collector watches the repositories a session actually touched and reports
 * the SHAs that appear inside the session window.
 */
export interface WatchedRepo {
  gitRoot: string;
  sessionId: string;
  agent: NormalizedEvent['event']['agent'];
  agentVersion?: string;
  /** Earliest event seen for this session in this repo. */
  since: Date;
}

/** Nothing older than this is attributed to a session, however far back its transcript runs. */
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export class GitCommitWatcher {
  /** One entry per repo: the session most recently active in it. */
  private readonly repos = new Map<string, WatchedRepo>();
  /** SHAs already emitted, so a commit is reported once and not once per scan. */
  private readonly emitted = new Set<string>();
  /** cwd -> git root, so a repeated cwd costs no filesystem walk. */
  private readonly roots = new Map<string, string | null>();

  /** Records which repo each session is working in. Cheap: no git process. */
  observe(events: NormalizedEvent[]): void {
    for (const item of events) {
      const cwd = item.cwd;
      if (!cwd) continue;

      let root = this.roots.get(cwd);
      if (root === undefined) {
        root = findGitRoot(cwd);
        this.roots.set(cwd, root);
      }
      if (!root) continue;

      const occurredAt = new Date(item.event.occurred_at);
      const at = Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt;
      const existing = this.repos.get(root);

      // A new session in this repo takes it over; the same session only ever
      // widens its window backwards.
      if (existing && existing.sessionId === item.event.session_id) {
        if (at < existing.since) existing.since = at;
        continue;
      }
      this.repos.set(root, {
        gitRoot: root,
        sessionId: item.event.session_id,
        agent: item.event.agent,
        agentVersion: item.event.agent_version,
        since: at,
      });
    }
  }

  /**
   * One `git log` per watched repo, at most once per call. Repos are dropped
   * afterwards: a repo is re-armed by the next event from it, so an idle
   * project costs nothing.
   */
  async poll(now: Date = new Date()): Promise<NormalizedEvent[]> {
    const watched = [...this.repos.values()];
    this.repos.clear();
    const events: NormalizedEvent[] = [];

    for (const repo of watched) {
      const since = new Date(Math.max(repo.since.getTime(), now.getTime() - MAX_LOOKBACK_MS));
      for (const commit of await commitsSince(repo.gitRoot, since)) {
        const key = `${repo.gitRoot}:${commit.sha}`;
        if (this.emitted.has(key)) continue;
        this.emitted.add(key);

        events.push({
          event: {
            occurred_at: commit.committedAt,
            session_id: repo.sessionId,
            agent: repo.agent,
            agent_version: repo.agentVersion,
            event_type: 'git.commit',
            payload: {
              sha: commit.sha,
              committed_at: commit.committedAt,
              additions: commit.additions,
              deletions: commit.deletions,
              files_changed: commit.filesChanged,
            },
          },
          cwd: repo.gitRoot,
        });
      }
    }

    // The set only guards against re-emitting inside one process; a long-lived
    // daemon should not grow it forever.
    if (this.emitted.size > 5000) this.emitted.clear();
    return events;
  }
}
