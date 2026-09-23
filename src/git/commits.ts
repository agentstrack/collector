import type { NormalizedEvent } from '../adapters/types.js';
import { deterministicEventId } from '../queue/event-id.js';
import { commitShasSince, commitStat, findGitRoot } from './repo.js';

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

/** Overlap added below each repo's last poll time so a commit landing right at the boundary is not missed. */
const POLL_OVERLAP_MS = 60 * 1000;

export class GitCommitWatcher {
  /** One entry per repo: the session most recently active in it. */
  private readonly repos = new Map<string, WatchedRepo>();
  /**
   * `${gitRoot}:${sha}` -> ms it was emitted. Guards against re-emitting a
   * commit; pruned by age instead of cleared wholesale, so nothing still inside
   * the lookback window is ever re-reported.
   */
  private readonly emitted = new Map<string, number>();
  /** gitRoot -> ms of the last poll, so the next `git log --since` starts from there. */
  private readonly lastPolled = new Map<string, number>();
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
    const floor = now.getTime() - MAX_LOOKBACK_MS;

    for (const repo of watched) {
      // Start from the later of: the session's own window, the last time we
      // polled this repo (minus a small overlap), and the hard lookback floor.
      // The last-poll bound keeps `git log` from re-scanning history it already
      // covered on every 5s tick.
      const lastPolled = this.lastPolled.get(repo.gitRoot);
      const sinceMs = Math.max(
        repo.since.getTime(),
        lastPolled === undefined ? -Infinity : lastPolled - POLL_OVERLAP_MS,
        floor,
      );
      this.lastPolled.set(repo.gitRoot, now.getTime());

      for (const ref of await commitShasSince(repo.gitRoot, new Date(sinceMs))) {
        const key = `${repo.gitRoot}:${ref.sha}`;
        if (this.emitted.has(key)) continue;
        this.emitted.set(key, now.getTime());

        // Diffstat is fetched only for a commit we have not emitted before.
        const stat = await commitStat(repo.gitRoot, ref.sha);
        events.push({
          event: {
            occurred_at: ref.committedAt,
            session_id: repo.sessionId,
            agent: repo.agent,
            agent_version: repo.agentVersion,
            event_type: 'git.commit',
            payload: {
              sha: ref.sha,
              committed_at: ref.committedAt,
              additions: stat.additions,
              deletions: stat.deletions,
              files_changed: stat.filesChanged,
            },
          },
          cwd: repo.gitRoot,
          // `emitted` is in memory, so a restart inside the window re-emits the
          // commit; a fixed id lets the server drop the repeat.
          eventId: deterministicEventId(`git.commit\n${repo.agent}\n${repo.sessionId}\n${ref.sha}`),
        });
      }
    }

    // Prune only entries past the window; anything still inside it must stay so
    // it is never re-emitted.
    for (const [key, at] of this.emitted) {
      if (at < floor) this.emitted.delete(key);
    }
    return events;
  }
}
