# Roadmap

What is missing, why, and what helping would actually involve. This is the list of things the
collector does **not** do as of 0.7.0 — kept here so nobody has to discover them by watching a
dashboard stay empty. Items that have shipped are marked **Done** with the release that shipped
them, so the reasoning stays findable.

There are no dates. This is a young project with a small number of maintainers; ordering is by how
much a thing unblocks, and anything on this list moves faster with someone working on it. See
[GOVERNANCE.md](./GOVERNANCE.md) for how something gets from this file into a release.

**Before you start on anything here, open an issue saying so.** Not for permission — to avoid two
people writing the same adapter in the same fortnight, and because the design constraints below are
easier to discuss before the code than during review.

---

## 1. Adapters for the other agents

**Status:** Claude Code, Codex, OpenCode (0.2.0), Antigravity CLI and Gemini CLI (0.5.0) have
adapters, and Kimi Code has an opt-in, experimental one (0.5.0) that has not yet been checked
against real sessions. Three agent ids are reserved in the schema enum with no adapter behind them —
`cursor`, `cline`, `copilot_cli`. The ids exist so that when an adapter lands it does not need a
schema change on both sides of the wire; they are not a claim of support. `agentstrack status` will
never list them today.

**Why it matters:** the product's premise is vendor-neutral comparison, and the agents a team
actually uses are the ones that count.

**The hard constraint:** the agent must write a log we can read, and it must carry token counts. The
collector reads files and installs no hooks — see
[CONTRIBUTING.md](./CONTRIBUTING.md#why-there-is-no-installhooks) for the three reasons that is a
rule and not a preference. Some of these agents may simply not log enough. Finding that out and
writing it down is itself a contribution. Verifying the Kimi Code adapter against a real session is
one too.

**Help wanted — this is the highest-value contribution to the repo, and the best-scoped.** One file
implementing `detect()`, `health()` and `normalize()` (or `poll()` for an agent that keeps a
database), one redacted fixture, one test.
[CONTRIBUTING.md](./CONTRIBUTING.md#adding-a-new-agent-adapter) is a step-by-step. The genuinely
useful precursor, if you do not want to write TypeScript: open an
[agent support request](https://github.com/agentstrack/collector/issues/new?template=agent_support.yml)
documenting **where the agent writes its logs, one redacted sample line of each type, and whether
token usage appears in them**. That research is most of the work.

Difficulty: **medium**, and self-contained. A broken adapter degrades one agent; it cannot leak
anything or corrupt the queue.

---

## 2. Event types nothing emits

**Status:** the schema declares the 18 blueprint event types plus `rate_limit.reported`. Two of the
original four gaps are closed; two remain:

| Event | Status |
|---|---|
| `session.ended` | **Done (0.3.0).** The daemon emits it for a session quiet longer than `tracking.idle_timeout_seconds` (`reason: timeout`). Since 0.7.0 it is not emitted on shutdown or restart, which cut open sessions short, and not while a backfill is still reading a file. OpenCode ends sessions on archive or compaction. |
| `git.branch_changed` | **Done (0.7.0).** Emitted when a repository's branch differs from the last one this process read, with `{ from, to }`. The first read after a start is never a change. |
| `heartbeat` | Open. The daemon posts liveness to `POST /v1/collector/health` every 60s instead. The event-stream version would let the server distinguish "collector was up and the developer was idle" from "collector was down", which health-posts alone do not. |
| `model.request` | Open. No transcript logs the request separately from the response, so request/response latency cannot be recovered from the files. It would need a source that records both. |

**Help wanted:** `heartbeat` is worth an issue first — it is cheap to emit, but it counts against
the org's ingest quota, so the interval is a product question.

---

## 3. Inert or overlapping config keys

- `tracking.idle_timeout_seconds` — **live since 0.3.0.** It decides when a quiet session gets
  `session.ended`. Time accounting (human-active, agent-active, idle) is still derived server-side
  from the event stream.
- `tracking.process_metrics` — **deprecated, no effect.** There is no CPU or memory sampling
  anywhere in the collector. The key is still accepted, because removing it would break existing
  config files, and since 0.7.0 setting it to `false` prints a warning saying it does nothing.
- `privacy.shell_arguments: full` — **still behaves exactly like `redact_secrets`**, because
  redaction is applied to commands unconditionally. That is arguably correct, but the config offers
  a distinction it does not honour.

Leaving keys that look like controls and are not is the failure `privacy.prompts` had before it was
fixed. Since 0.7.0 an unknown key prints a warning, which catches typos; it does not help with a key
that is spelt right and does nothing.

**Help wanted:** the decision more than the code. An issue arguing whether `shell_arguments: full`
should mean "no redaction" (and why that would be safe) or be folded into `redact_secrets` in the
next major is a real contribution.

---

## 4. Content-derived `event_id`, for replay-safe re-reads

**Done (0.3.0).** `event_id` is derived from the adapter, the file, the line's byte offset and the
line's content, so re-reading a replaced or truncated transcript produces the same ids and the
server's idempotency absorbs it. Claude Code `model.response` is keyed on `message.id` (one response
spans several lines), `git.commit` on the session and the SHA (0.4.4), `session.ended` on the agent,
session and last-activity time. OpenCode's events, which come from database rows rather than lines,
still get a random id; a database-backed equivalent keyed on the row is open.

---

## 5. `MultiEdit`

**Done (0.7.0).** A `MultiEdit` call produces one `file.changed` with `lines_added` /
`lines_removed` summed over its edits — what `git diff --numstat` would report for the file. Line
counts are computed in the adapter, because the privacy pipeline deletes `old_string` /
`new_string` before anything is uploaded.

---

## 6. Smaller, and genuinely wanted

| Gap | Notes |
|---|---|
| **Backfill window** | **Done (0.2.1):** `tracking.max_age_days` (default 7, up to 3650) sets how far back the scan looks; `sync --full` re-reads everything inside it. A per-run override (`sync --since 30d`) is still open — making a *narrower* window not silently drop history is the part to get right. |
| **`--verbose` logging** | **Done (0.7.0):** counts, batch sizes and status codes only — never a prompt, code content, a path or a key. |
| **Per-run agent selection** | **Done (0.7.0):** `start --foreground --agent <id>`. Foreground only, since the service runs without flags. |
| **`duration_ms` on `agent.turn.ended`** | **Deliberately removed (0.6.2).** The turn end is end-stamped, and a duration on it was counted after the turn as well; the turn's span is `agent.turn.started` → `agent.turn.ended`. |
| **`config get` / `set` / `edit`** | Open. Edit the YAML by hand today. Any implementation must keep the "invalid config is a hard error, never a silent fallback" rule — a `config set` that writes an unparseable file and shrugs is worse than no command. |
| **`task_category`** | Open. In the schema, never populated. Would be a local classifier over the prompt — and it must run locally and discard the prompt, exactly as `derived_title` does. |
| **Windows** | Open. The service installer is launchd + systemd. `agentstrack start --foreground` works anywhere Node 24+ does, so the gap is specifically a Scheduled Task or service wrapper, plus path handling review. Wanted, and needs someone who runs Windows to own it. |
| **Standalone binary / Homebrew** | In progress on the `feat/standalone-binary` branch: a single-executable build with checksums and attestations, an installer, and a Homebrew tap, so the collector can run without a global npm install. Not released. |

---

## Not on the roadmap

Some things are absent on purpose. They are not oversights and PRs adding them will be declined:

- **Hooks.** The collector will not write to `~/.claude/settings.json`, `~/.codex/hooks.json`, or any
  agent's configuration. [Three reasons.](./CONTRIBUTING.md#why-there-is-no-installhooks)
- **Reading your source tree.** It opens agent transcripts. Nothing else.
- **Per-developer scores, rankings or leaderboards.** An explicit product decision, not a missing
  feature. The collector reports workflows, cost and outcomes.
- **Looser privacy defaults "for better analytics."** Every default is the strict one, and widening
  one is a breaking change requiring a very good argument.
- **New runtime dependencies** without discussion in an issue first. This package is installed
  globally on developers' machines; every dependency is supply-chain surface.
