# Event schema (v1)

Everything the collector can transmit is on this page. If a field is not documented here, the
collector does not send it.

The collector and the AgentsTrack server validate against the same shape. The collector's copy lives
in [`src/schema.ts`](../src/schema.ts); the canonical payload schemas live in the server's
`@agentstrack/event-schema` package. `npm test` includes a contract test: it always asserts the 18
event types and that the envelope carries no tenancy fields, and additionally diffs the enums against
the server's generated `EVENT_SCHEMA.json` **when the server repository is checked out alongside this
one** — that comparison is skipped, not failed, when it is not.

- **Schema version:** `1`
- **Transport:** `POST {api_url}/v1/events/batch`, `Authorization: Bearer <api_key>`
- **Body:** `{ "events": [ … ] }`, 1–500 events. The collector sends `upload.batch_size` (default
  100) every `upload.interval_seconds` (default 30), gzipped when the JSON exceeds 1 KB.
- **Idempotency:** ingestion is idempotent on `event_id`, so retrying a batch after a timeout cannot
  double-count.
- **Response:** `{ "accepted": 97, "duplicates": 3, "rejected": [] }`

---

## What is deliberately *not* in the envelope

**`organization_id` and `user_id` do not exist in this schema.**

That is not an omission. The server derives both from the API key on the request. A collector that
could name its own tenant could write events into another organization's history by changing a field
in a JSON body; making the field absent removes the class of bug entirely. If a client sends them
anyway they are stripped, not honoured.

Consequences:

- An event is attributed to whoever owns the key that uploaded it. Nothing else.
- A leaked key can write into that one user's history. It cannot forge another tenant's.
- Rotating a key re-attributes nothing retroactively.

Also absent from every payload outside opt-in `full` mode: prompt text and code content. See the
[privacy section of the README](../README.md#privacy). When redaction catches a secret the envelope
reports the pattern and a count ([`secrets_redacted`](#secrets_redacted)) — never the matched value,
not even hashed.

---

## The envelope

Every event, from every adapter, has exactly this shape.

| Field | Type | Required | Notes |
|---|---|---|---|
| `event_id` | UUID | ✅ | Generated locally at enqueue. The idempotency key. |
| `schema_version` | `1` | ✅ | Literal. A different value is rejected, not coerced. |
| `occurred_at` | ISO-8601 with offset | ✅ | Taken from the agent's own log line — when it happened, not when it uploaded. |
| `collector_id` | UUID | ✅ | Assigned by the server at registration. Identifies the machine. |
| `session_id` | string (1–200) | ✅ | The **agent-native** session id, stable for the session's lifetime. |
| `agent` | enum | ✅ | `claude_code` · `codex` · `gemini_cli` · `opencode` · `cursor` · `cline` · `copilot_cli` · `other` |
| `agent_version` | string (≤50) | — | As reported by the agent in its own log. |
| `event_type` | enum | ✅ | One of the 18 below. |
| `payload` | object | ✅ | Defaults to `{}`. Shape depends on `event_type`. |

Unknown payload keys are **kept, not rejected** — a newer collector talking to an older server
degrades rather than fails, and an older server stores keys it does not yet read. A malformed event rejects that event only, never the whole batch: a
collector that cannot drain its spool would lose a developer's whole day.

---

## Which of the 18 the collector emits today

The schema is the contract; 0.1.0 does not fill all of it. Nothing here is aspirational —
this column is what the adapters in this repository actually produce.

| Event type | Claude Code | Codex | OpenCode | Source |
|---|---|---|---|---|
| `session.started` | — | ✅ | ✅ | `session_meta` line / `session` row |
| `session.ended` | ✅ | ✅ | ✅ | daemon idle timeout (`reason: timeout`, `unknown` on shutdown) / `session.time_archived` or `time_compacting` |
| `user.prompted` | ✅ | ✅ | ✅ | `user` line / `user_message` / `text` part of a user message |
| `agent.turn.started` | — | ✅ | — | `turn_context` |
| `agent.turn.ended` | — | ✅ | — | `task_complete` |
| `model.request` | — | — | — | not emitted in 0.1.0 |
| `model.response` | ✅ | — | — | `assistant` line with `usage` |
| `tool.started` | ✅ | ✅ | — | `tool_use` / `function_call`, `custom_tool_call` |
| `tool.completed` | ✅ | ✅ | ✅ | `tool_result` / `*_output` / `tool` part, `status: completed` |
| `tool.failed` | ✅ | ✅ | ✅ | `is_error` / `exec_command_end` exit code, `Exit code: N` output header / `status: error` |
| `file.read` | ✅ | ✅ | ✅ | `Read` tool / pager & `cat`-family commands / `read` tool part |
| `file.changed` | ✅ | ✅ | ✅ | `Edit`/`Write` input / `apply_patch` body / `edit` & `write` tool parts |
| `command.executed` | ✅ | ✅ | ✅ | `Bash` tool input / `exec_command_end` / `bash` tool part |
| `git.commit` | ✅ | ✅ | ✅ | `git log` in repos a session touched — not from the transcript |
| `git.branch_changed` | — | — | — | not emitted in 0.1.0 |
| `usage.reported` | — | ✅ | ✅ | `token_count` / `session` row totals — always `cumulative: true` |
| `error` | — | ✅ | — | `error` / `stream_error` |
| `heartbeat` | — | — | — | not emitted in 0.1.0 |

OpenCode emits no `tool.started`: one `part` row carries the whole call, so the terminal event is
timestamped at the call's **start** and carries the real `duration_ms`. The server backfills the
invocation count from the terminal events, so nothing is lost.

Fields the schema allows but 0.1.0 never populates: `task_category`, `latency_ms`,
`model.response.turn_id`, `file.read.lines`, `error.fatal`. `reported_cost_usd` is populated by
OpenCode only — it is the one agent here that records what the provider actually charged.

---

## Shared payload structures

### `TokenUsage`

Token accounting normalized across agents. Claude Code reports cache creation and cache reads
separately; Codex reports `cached_input_tokens` and reasoning tokens. Both map onto this one shape,
which is what makes cross-agent cost comparison honest.

| Field | Type | Default | Notes |
|---|---|---|---|
| `input_tokens` | int ≥ 0 | `0` | |
| `cached_input_tokens` | int ≥ 0 | `0` | Read from cache — billed at a reduced rate. **Exclusive of `input_tokens`**: the two never overlap. Claude Code's `cache_read_input_tokens` already is; Codex's `cached_input_tokens` is a subset of its `input_tokens`, so the collector subtracts it; OpenCode's `tokens_cache_read` is already separate. |
| `cache_creation_input_tokens` | int ≥ 0 | `0` | Written to cache — billed at a premium. Claude Code only. |
| `output_tokens` | int ≥ 0 | `0` | |
| `reasoning_output_tokens` | int ≥ 0 | `0` | Thinking tokens. **A subset of `output_tokens`, not additive** — do not sum the two. |

### `Account`

Which account of the agent produced this work. One machine routinely drives several — a personal
Claude login and a work one, an OpenRouter key and an Anthropic subscription — and without this they
all collapse into a single identity with a single, wrong, cost split.

Attached to `session.started` and `user.prompted` only; every other event inherits it from its
session.

| Field | Type | Sent in | Notes |
|---|---|---|---|
| `key` | string ✅ | **all modes** | Stable, opaque, non-PII. Claude Code: `oauthAccount.accountUuid`. OpenCode: `<serviceID>:<accountId>`, **never** the credential. This is what makes sessions split per account, which has to work in `metadata` mode too — there the account simply shows as opaque rather than as an email. |
| `label` | string | `analytics`, `full` | Email or display name. **PII** — stripped by the privacy pipeline in `metadata` mode. |
| `org` | string | `analytics`, `full` | Organization name. **PII** — stripped in `metadata` mode. |
| `provider` | string | all modes | `anthropic`, `openrouter`, `openai`, … |

**Live events only.** `~/.claude.json` and OpenCode's `account.json` record who is signed in *now*
and keep no history: they are rewritten in place on an account switch. So an event whose
`occurred_at` predates the collector's start — a transcript already on disk at first run, or
anything from a window when the daemon was down — carries **no** `account` at all rather than
today's account, which would be a plausible-looking lie. Live events, written while the collector
was watching, carry one. Both files are re-read every scan cycle (cached on mtime), not once at boot.

### Sub-agent stamp

Claude Code writes each sub-agent to its own transcript,
`<session-uuid>/subagents/[workflows/<wf>/]agent-<id>.jsonl`, with the **parent's** `sessionId` on
every line. So a sub-agent's events land in the parent session — and every one of them carries this
stamp, so the server can tell them apart and attribute the sub-agent's own `model.response` usage.
Absent on every event from the main transcript.

| Field | Type | Notes |
|---|---|---|
| `sidechain` | `true` | The line has `isSidechain: true` or comes from a `subagents/` file. |
| `agent_id` | string | The transcript's `agentId` (also the `agent-<id>` in the file name). |
| `agent_kind` | `subagent` \| `workflow` | `workflow` when the file sits under `subagents/workflows/`. |
| `agent_type` | string | `agentType` from the sibling `agent-<id>.meta.json` — `general-purpose`, `workflow-subagent`, a custom agent name. Absent when the meta file is missing. |

### `secrets_redacted`

Present on **any** event where local redaction fired, in **every** privacy mode including
`metadata`. It reports *that* a secret-shaped string was found and *which* pattern matched — never
the value.

| Field | Type | Notes |
|---|---|---|
| `kind` | string | The rule that matched: a built-in name (`aws_access_key`, `github_token`, …) or `org_rule` for anything your organization added — an org rule name can itself describe the shape of that org's secrets, so it is never sent. |
| `count` | int ≥ 1 | How many matches that rule replaced across the event's text fields. A secret echoed in both a prompt and its derived title counts twice. |

```json
"secrets_redacted": [
  { "kind": "aws_access_key", "count": 1 },
  { "kind": "github_token", "count": 2 }
]
```

Sorted by `kind`, and **absent entirely** when nothing fired — the key's presence is itself the
signal. The tally is computed before the mode strip deletes the text, which is why it survives
`metadata` mode: the count is metadata, the prompt is not. What never appears here, or anywhere
else in the envelope: the matched text, a prefix of it, a hash of it, or the characters around it.

### `RepoContext`

| Field | Type | Notes |
|---|---|---|
| `remote_hash` | string | **SHA-256 of the normalized git remote URL.** Never the URL itself. ssh and https clones of one repo hash identically. |
| `remote_owner` | string | e.g. `acme` |
| `remote_name` | string | e.g. `api` |
| `branch` | string | From `.git/HEAD`. Absent on a detached HEAD. |
| `project_path` | string | **Dropped** under `file_paths: never` and `relative` (the default). Sent only under `absolute`. |
| `project_name` | string | Basename of the git root. |

Attached to events by the daemon when `tracking.git_metadata` is `true` (the default), based on the
session's working directory.

---

## The 18 event types

### Session lifecycle

#### `session.started`

| Field | Type | Notes |
|---|---|---|
| `external_session_id` | string ✅ | The agent's own session id. |
| `cwd` | string | The project root. **Dropped** unless `privacy.file_paths` is `absolute`. |
| `model` | string | Model the session opened with. |
| `provider` | string | Provider the session ran on, when the agent records one. |
| `agent_mode` | string | The agent's own mode label — OpenCode's `build` / `plan`. |
| `parent_session_id` | string | Set on a sub-agent session (OpenCode's `task` tool). |
| `derived_title` | string | Same privacy rules as on `user.prompted`. OpenCode names its own sessions, so this one is whatever OpenCode already truncated it to; it is redacted by the pipeline, but any truncation upstream of us is outside our control. |
| `account` | `Account` | See below. |
| `repo` | `RepoContext` | |

#### `session.ended`

| Field | Type | Notes |
|---|---|---|
| `external_session_id` | string ✅ | |
| `reason` | `normal` \| `timeout` \| `crash` \| `unknown` | Defaults to `unknown`. |
| `end_kind` | `archived` \| `compacted` | OpenCode only — what the editor actually did to the session. It always sends `reason: normal`; the enum above has no room for the distinction, and the server keeps unknown keys. |

#### `heartbeat`

| Field | Type | Notes |
|---|---|---|
| `queue_depth` | int ≥ 0 | Events waiting in the local spool. |

### Interaction

#### `user.prompted`

The event where privacy mode is most visible.

| Field | Type | Sent in |
|---|---|---|
| `prompt_chars` | int ≥ 0 | all modes — a **count**, not the text |
| `derived_title` | string (≤200) | `analytics`, `full` — the first meaningful line of the prompt, computed **on your machine**: the prompt is secret-redacted first, then truncated to 120 characters, then the raw text is deleted. Redaction before truncation is what stops a key that straddles the cut from shipping as an unmatchable fragment (fixed in 0.4.1). Dropped under `privacy.prompts: never` in every mode, and in `metadata` by the mode itself |
| `task_category` | enum | schema only — not populated in 0.1.0 |
| `ultracode` | `true` | all modes — present only when the prompt contains the whole word `ultracode` (case-insensitive). A boolean computed locally before redaction; the prompt is not uploaded to find it. |
| `prompt_text` | string | **`full` mode with `privacy.prompts: full` only.** Redacted first; absent entirely otherwise. |
| `account` | `Account` | all modes — but `label` and `org` only in `analytics` and `full`. See below. |

#### `agent.turn.started` / `agent.turn.ended`

| Field | Type | Notes |
|---|---|---|
| `turn_id` | string | |
| `model` | string | `started` only. The model the turn opened with, when the agent states it — Codex's `turn_context`. |
| `duration_ms` | int ≥ 0 | `ended` only. Not populated in 0.1.0. |

### Model traffic

#### `model.request`

| Field | Type | Notes |
|---|---|---|
| `model` | string ✅ | |
| `provider` | string | |
| `turn_id` | string | |

#### `model.response`

| Field | Type | Notes |
|---|---|---|
| `model` | string ✅ | e.g. `claude-opus-5` |
| `provider` | string | e.g. `anthropic` |
| `turn_id` | string | |
| `usage` | `TokenUsage` | |
| `latency_ms` | int ≥ 0 | Agent-active time, never counted as human time. |
| `stop_reason` | string | e.g. `tool_use`, `end_turn` |

No response content is ever included, in any mode. Claude Code messages whose model is a synthetic
placeholder (interrupts, injected notices) are dropped, so they never reach the model or cost tables.

#### `usage.reported`

A usage snapshot, for agents that report totals rather than per-request numbers.

| Field | Type | Notes |
|---|---|---|
| `usage` | `TokenUsage` ✅ | |
| `model` | string | |
| `provider` | string | |
| `cumulative` | boolean | Defaults to `false`. **When `true` these are running totals — the server takes the max (a gauge), it must not sum them (a counter).** Codex and OpenCode always emit `true`. Known limit: the total is session-wide but tagged with the *current* model, and the server gauges per model, so a session that switches model mid-way (`/model`) has its whole total counted under both. Codex's per-turn `last_token_usage` was measured against real rollouts and does not reconcile to the final total (duplicate snapshots, resets), so the gauge stays. |
| `reported_cost_usd` | number ≥ 0 | Only when the agent exposes a cost. Drives `basis: REPORTED` rather than `ESTIMATED`. OpenCode's `session.cost` is a real settled provider charge and lands here. |
| `plan_type` | string | Subscription plan where known — a subscription "cost" is always an API-equivalent estimate and is labelled as such. |

### Tools

#### `tool.started` / `tool.completed` / `tool.failed`

| Field | Type | `started` | `completed` | `failed` |
|---|---|---|---|---|
| `tool_name` | string ✅ | ✅ | ✅ | ✅ |
| `tool_call_id` | string | ✅ | ✅ | ✅ |
| `duration_ms` | int ≥ 0 | — | schema only | schema only |
| `error_kind` | string | — | — | schema only |
| `skill` | string | ✅ | ✅ | ✅ |
| `subagent_type` | string | ✅ | ✅ | ✅ |
| `description` | string | ✅ | ✅ | ✅ |
| `workflow_name` | string | ✅ | ✅ | ✅ |

Tool **input and output are never sent**, in any mode. `error_kind` is a classification, never the
error text. The last four are the exception that proves it, and name only *what* was invoked:
a Claude Code `Skill` call carries `skill` (the skill name); `Agent` carries `subagent_type` and
`description` (the agent's one-line label — redacted like a title and dropped in `metadata` mode;
the `Agent` call's prompt is never copied out of the call — the sub-agent transcript's own opening
prompt is a `user.prompted` like any other and follows `privacy.prompts`); `Workflow` carries `workflow_name`, the `name` from
the script's `meta` header when it is a plain string literal (the script itself is never sent).
The `completed` / `failed` event repeats them, because that is the one the server counts.

### Files and commands

#### `file.read`

| Field | Type | Notes |
|---|---|---|
| `path` | string ✅ | Subject to `privacy.file_paths`. |
| `lines` | int | Line count. Never the lines. Not populated in 0.1.0. |

#### `file.changed`

| Field | Type | Notes |
|---|---|---|
| `path` | string ✅ | Subject to `privacy.file_paths`. |
| `change_kind` | `create` \| `edit` \| `delete` \| `rename` | Defaults to `edit`. |
| `lines_added` | int ≥ 0 | Computed locally from the tool input or patch body. |
| `lines_removed` | int ≥ 0 | Same. Lines present on both sides count as neither. |

Counts only. The diff itself is deleted by the privacy pipeline before upload, which is why the
counts have to be derived in the adapter.

#### `command.executed`

| Field | Type | Notes |
|---|---|---|
| `command` | string ✅ | The command line, with the 15 built-in secret rules applied — this is the default (`shell_arguments: redact_secrets`). Set `shell_arguments: never` to truncate it to the first whitespace token. |
| `exit_code` | int | Codex only. |
| `duration_ms` | int ≥ 0 | Codex only. |

### Git

#### `git.commit`

Emitted by the collector itself, from `git log --numstat --no-merges` in repositories a session
touched — no agent writes commits to its transcript. Attributed to the session active in that repo,
with a 24-hour maximum lookback.

| Field | Type | Notes |
|---|---|---|
| `sha` | string ✅ | Used to correlate sessions to PRs, with a visible confidence level. |
| `committed_at` | ISO-8601 | Normalized to UTC. |
| `additions` | int ≥ 0 | |
| `deletions` | int ≥ 0 | Binary files count as 0, matching `git`. |
| `files_changed` | int ≥ 0 | |
| `repo` | `RepoContext` | |

Commit **messages and diffs are not sent.**

#### `git.branch_changed`

| Field | Type |
|---|---|
| `to` | string ✅ |
| `from` | string |
| `repo` | `RepoContext` |

### Diagnostics

#### `error`

| Field | Type | Notes |
|---|---|---|
| `error_kind` | string ✅ | Classification — Codex emits `error` or `stream_error`. |
| `message` | string (≤1000) | Truncated at the adapter, then redacted, then **deleted entirely in `metadata` mode**. |
| `fatal` | boolean | Defaults to `false`. Not populated in 0.1.0. |

---

## A worked example

A real `model.response`, produced by running the committed Claude Code fixture through the adapter
and the privacy pipeline in the default `analytics` mode — exactly the bytes that would go into a
batch body:

```json
{
  "occurred_at": "2026-08-26T10:00:12.000Z",
  "session_id": "06f3470f-d924-4552-b3ee-3f8924286cec",
  "agent": "claude_code",
  "agent_version": "2.1.241",
  "event_type": "model.response",
  "payload": {
    "model": "claude-opus-5",
    "provider": "anthropic",
    "usage": {
      "input_tokens": 2,
      "cached_input_tokens": 26254,
      "cache_creation_input_tokens": 39728,
      "output_tokens": 505,
      "reasoning_output_tokens": 257
    },
    "stop_reason": "tool_use"
  },
  "event_id": "6b1f0f5e-3f7a-4b1c-9a2e-8d4c5f6a7b80",
  "schema_version": 1,
  "collector_id": "3f9a1e6c-1c4b-4c7e-9d0f-2a5b8c1d7e40"
}
```

The prompt that started that turn, from the same fixture. The raw text was 81 characters; what
leaves the machine is the count and a locally derived title:

```json
{
  "occurred_at": "2026-08-26T10:00:00.000Z",
  "session_id": "06f3470f-d924-4552-b3ee-3f8924286cec",
  "agent": "claude_code",
  "agent_version": "2.1.241",
  "event_type": "user.prompted",
  "payload": {
    "prompt_chars": 81,
    "derived_title": "Add tests for the cost calculator"
  },
  "event_id": "6b1f0f5e-3f7a-4b1c-9a2e-8d4c5f6a7b80",
  "schema_version": 1,
  "collector_id": "3f9a1e6c-1c4b-4c7e-9d0f-2a5b8c1d7e40"
}
```

A file edit, with the paths already relativized and the diff already gone:

```json
{
  "occurred_at": "2026-08-26T10:01:00.000Z",
  "session_id": "06f3470f-d924-4552-b3ee-3f8924286cec",
  "agent": "claude_code",
  "agent_version": "2.1.241",
  "event_type": "file.changed",
  "payload": {
    "path": "src/cost.test.ts",
    "change_kind": "create",
    "lines_added": 1,
    "lines_removed": 0
  },
  "event_id": "6b1f0f5e-3f7a-4b1c-9a2e-8d4c5f6a7b80",
  "schema_version": 1,
  "collector_id": "3f9a1e6c-1c4b-4c7e-9d0f-2a5b8c1d7e40"
}
```

Uploaded as `{ "events": [ … ] }`; the response is
`{ "accepted": 97, "duplicates": 3, "rejected": [] }`.

Note what none of these contain: no `organization_id`, no `user_id`, no prompt, no response text, no
file contents, no absolute path, no git remote URL.

## See it for yourself

```bash
agentstrack sync --dry-run --print
```

Runs the full privacy pipeline over your own queued events, prints the literal JSON, and uploads
nothing.
