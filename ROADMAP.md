# Roadmap

What is missing, why, and what helping would actually involve. This is the list of things the
collector does **not** do at 0.1.0 — kept here so nobody has to discover them by watching a dashboard
stay empty.

There are no dates. This is a young project with a small number of maintainers; ordering is by how
much a thing unblocks, and anything on this list moves faster with someone working on it. See
[GOVERNANCE.md](./GOVERNANCE.md) for how something gets from this file into a release.

**Before you start on anything here, open an issue saying so.** Not for permission — to avoid two
people writing the same adapter in the same fortnight, and because the design constraints below are
easier to discuss before the code than during review.

---

## 1. Adapters for the other agents

**Status:** five agent ids are reserved in the schema enum with no adapter behind them —
`gemini_cli`, `opencode`, `cursor`, `cline`, `copilot_cli`. The ids exist so that when an adapter
lands it does not need a schema change on both sides of the wire; they are not a claim of support.
`agentstrack status` will never list them today.

**Why it matters:** the product's premise is vendor-neutral comparison. Two agents is enough to prove
the normalization works and not enough to answer "which of these is actually cheaper for this team".

**The hard constraint:** the agent must write a log we can read, and it must carry token counts. The
collector tails files and installs no hooks — see
[CONTRIBUTING.md](./CONTRIBUTING.md#why-there-is-no-installhooks) for the three reasons that is a
rule and not a preference. Some of these agents may simply not log enough. Finding that out and
writing it down is itself a contribution.

**Help wanted — this is the highest-value contribution to the repo, and the best-scoped.** One file
implementing `detect()`, `health()` and `normalize()`, one redacted fixture, one test.
[CONTRIBUTING.md](./CONTRIBUTING.md#adding-a-new-agent-adapter) is a step-by-step. The genuinely
useful precursor, if you do not want to write TypeScript: open an
[agent support request](https://github.com/agentstrack/collector/issues/new?template=agent_support.yml)
documenting **where the agent writes its logs, one redacted sample line of each type, and whether
token usage appears in them**. That research is most of the work.

Difficulty: **medium**, and self-contained. A broken adapter degrades one agent; it cannot leak
anything or corrupt the queue.

---

## 2. The four event types nothing emits

**Status:** the schema declares 18 event types. Adapters emit 14. These four are defined, documented
and accepted by the server, and no adapter produces them:

| Event | Why it is missing |
|---|---|
| `session.ended` | Neither agent writes an end-of-session marker. Ending a session means deciding it has ended — an idle threshold, or the transcript going quiet — and the collector has no timer today (see section 3 below). |
| `heartbeat` | The daemon posts liveness to `POST /v1/collector/health` every 60s instead. The event-stream version would let the server distinguish "collector was up and the developer was idle" from "collector was down", which health-posts alone do not. |
| `model.request` | Neither transcript logs the request separately from the response, so request/response latency cannot be recovered from the files. It would need a source that records both. |
| `git.branch_changed` | Branch is read per-event from `.git`; nothing compares it to the previous read and emits a transition. This is the smallest of the four by a distance. |

**Help wanted:** `git.branch_changed` is a **good first issue** — the branch is already being read
in `src/git/repo.ts`, so this is remembering the last value per repository and emitting on change,
plus a test. `session.ended` is worth discussing in an issue first, because "when is a session over"
is a product question with a wrong answer that would quietly corrupt duration analytics.

---

## 3. `tracking.idle_timeout_seconds` and `tracking.process_metrics`

**Status:** both are parsed, validated and range-checked by the config schema, and then **nothing
reads them**. `agentstrack config --show-effective` prints them, which makes them look live. They are
not.

- `idle_timeout_seconds` (30–3600, default 120) — time accounting is derived server-side from the
  event stream today. Human-active, agent-active and idle are tracked as separate quantities; wall
  clock is never presented as productive time. The collector-side timer this key implies does not
  exist.
- `process_metrics` (default `true`) — accepted and ignored entirely. There is no CPU or memory
  sampling anywhere in the collector.

**The honest options** are to implement them or to remove them, and removing a config key is a
breaking change to the config file shape. Leaving inert keys in a privacy tool is the worst of the
three: a key that looks like a control and is not is exactly the failure `privacy.prompts` had before
it was fixed.

**Help wanted:** the decision more than the code. An issue arguing for one of the three, with a
reason, is a real contribution. If it is "implement", `idle_timeout_seconds` producing local
`session.ended` events ties this to section 2 above.

---

## 4. Content-derived `event_id`, for replay-safe re-reads

**Status:** `event_id` is a random UUID assigned when an event is enqueued. That makes **retrying a
batch** safe — ingest is idempotent on `event_id`, so a retried upload cannot double-count. It does
**not** make **re-reading a file** safe: if a transcript is re-read from byte zero, the same
transcript lines produce fresh ids and land as duplicate events server-side.

That is not hypothetical. The tailer re-reads from zero by design when a file is replaced (new inode)
or truncated (offset past the end) — the alternative, silently skipping, loses data, so re-reading is
the right trade with today's ids.

**The fix:** derive `event_id` deterministically from content — a hash over
`(collector_id, source file identity, line offset, event index within the line)`, or over the
normalized event body. Then a re-read produces the *same* ids and the server's existing idempotency
absorbs it, and the tailer's "re-read rather than skip" choice costs nothing.

**The hard part** is choosing inputs that are stable across a re-read but distinct between two
genuinely identical events — two `tool.started` events for the same tool, in the same session, in the
same second, are a real thing that must not collapse into one. Byte offset within the file is the
obvious disambiguator and it is exactly what changes under truncation.

**Help wanted:** a design in an issue before a PR. This touches the durability guarantees, so the
test bar is high — a test that re-reads a fixture from zero and asserts the id set is unchanged, and
one that asserts two genuinely-distinct identical-looking events keep distinct ids. Difficulty:
**medium-hard**, and the most interesting problem on this list.

---

## 5. `MultiEdit`

**Status:** the Claude Code adapter derives `file.changed` events, with locally computed
`lines_added` / `lines_removed`, from `Edit`, `Write` and `NotebookEdit` tool inputs, and `file.read`
from `Read`. A `MultiEdit` call is recorded as `tool.started` / `tool.completed` like any other tool,
but produces **no `file.changed` events and no line counts** — so a session that edits mostly via
`MultiEdit` under-reports file activity.

**The shape of the fix:** `MultiEdit`'s input is a `file_path` plus an array of
`{ old_string, new_string }` edits. Each entry maps onto the existing `countEditLines()` multiset
diff; the open question is whether that is one `file.changed` per file with summed counts, or one per
edit. One per file is probably right — it is what `git diff --numstat` would report — but it needs
deciding rather than assuming.

**Help wanted: this is the best first issue in the repo.** It is one function in
`src/adapters/claude.ts`, the diffing logic already exists and is tested, and the test is a fixture
line plus an assertion on the counts. Note the constraint that makes it non-obvious: line counts
**must** be computed in the adapter, because the privacy pipeline deletes `old_string` / `new_string`
before anything is uploaded and no later stage can recover them.

---

## 6. Smaller, and genuinely wanted

| Gap | Notes |
|---|---|
| **Backfill window control** (`sync --since 30d`) | The scan reads `*.jsonl` modified in the last 7 days, hardcoded. Making it configurable is easy; making a *narrower* window not silently drop history is the part to get right. |
| **`config get` / `set` / `edit`** | Edit the YAML by hand today. Any implementation must keep the "invalid config is a hard error, never a silent fallback" rule — a `config set` that writes an unparseable file and shrugs is worse than no command. |
| **`--verbose` logging** | With the absolute rule that verbose still never logs a prompt, code content, or a key. |
| **Per-run agent selection** (`start --agent codex`) | `tracking.agents` covers it persistently; a flag is convenience for debugging an adapter. Good first issue. |
| **`task_category`** | In the schema, never populated. Would be a local classifier over the prompt — and it must run locally and discard the prompt, exactly as `derived_title` does. |
| **`duration_ms` on `agent.turn.ended`** | The field is defined and not populated. Codex logs turn boundaries, so this is arithmetic on two timestamps the adapter already sees. |
| **`shell_arguments: full`** | Behaves identically to `redact_secrets` today, because redaction is applied to commands unconditionally. That is arguably correct — but the config offers a distinction it does not honour, which is the section 3 problem again. |
| **Windows** | The service installer is launchd + systemd. `agentstrack start --foreground` works anywhere Node 20+ does, so the gap is specifically a Scheduled Task or service wrapper, plus path handling review. Wanted, and needs someone who runs Windows to own it. |

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
