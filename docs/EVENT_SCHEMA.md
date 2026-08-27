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
[privacy section of the README](../README.md#privacy).

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

Unknown payload keys are **stripped, not rejected** — a newer collector talking to an older server
degrades rather than fails. A malformed event rejects that event only, never the whole batch: a
collector that cannot drain its spool would lose a developer's whole day.

---

## Which of the 18 the collector emits today

The schema is the contract; 0.1.0 does not fill all of it. Nothing here is aspirational —
this column is what the adapters in this repository actually produce.

| Event type | Claude Code | Codex | Source |
|---|---|---|---|
| `session.started` | — | ✅ | `session_meta` line |
| `session.ended` | — | — | not emitted in 0.1.0 |
| `user.prompted` | ✅ | ✅ | `user` line / `user_message` |
| `agent.turn.started` | — | ✅ | `turn_context` |
| `agent.turn.ended` | — | ✅ | `task_complete` |
| `model.request` | — | — | not emitted in 0.1.0 |
| `model.response` | ✅ | — | `assistant` line with `usage` |
| `tool.started` | ✅ | ✅ | `tool_use` / `function_call`, `custom_tool_call` |
| `tool.completed` | ✅ | ✅ | `tool_result` / `*_output`, `web_search_call` |
| `tool.failed` | ✅ | ✅ | `is_error` / non-zero exit or `success: false` |
| `file.read` | ✅ | ✅ | `Read` tool / pager & `cat`-family commands |
| `file.changed` | ✅ | ✅ | `Edit`/`Write`/`NotebookEdit` input / `apply_patch` body, shell redirects |
| `command.executed` | ✅ | ✅ | `Bash` tool input / `exec_command_end` |
| `git.commit` | ✅ | ✅ | `git log` in repos a session touched — not from the transcript |
| `git.branch_changed` | — | — | not emitted in 0.1.0 |
| `usage.reported` | — | ✅ | `token_count`, always `cumulative: true` |
| `error` | — | ✅ | `error` / `stream_error` |
| `heartbeat` | — | — | not emitted in 0.1.0 |

Fields the schema allows but 0.1.0 never populates: `task_category`, `latency_ms`,
`model.response.turn_id`, `tool.*.duration_ms` (except `command.executed.duration_ms` from Codex),
`tool.failed.error_kind`, `reported_cost_usd`, `file.read.lines`, `error.fatal`.

---

## Shared payload structures

### `TokenUsage`

Token accounting normalized across agents. Claude Code reports cache creation and cache reads
separately; Codex reports `cached_input_tokens` and reasoning tokens. Both map onto this one shape,
which is what makes cross-agent cost comparison honest.

| Field | Type | Default | Notes |
|---|---|---|---|
| `input_tokens` | int ≥ 0 | `0` | |
| `cached_input_tokens` | int ≥ 0 | `0` | Read from cache — billed at a reduced rate. Claude Code's `cache_read_input_tokens`. |
| `cache_creation_input_tokens` | int ≥ 0 | `0` | Written to cache — billed at a premium. Claude Code only. |
| `output_tokens` | int ≥ 0 | `0` | |
| `reasoning_output_tokens` | int ≥ 0 | `0` | Thinking tokens. **A subset of `output_tokens`, not additive** — do not sum the two. |

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
| `cwd` | string | Subject to `privacy.file_paths`. |
| `model` | string | Model the session opened with. |
| `repo` | `RepoContext` | |

#### `session.ended`

| Field | Type | Notes |
|---|---|---|
| `external_session_id` | string ✅ | |
| `reason` | `normal` \| `timeout` \| `crash` \| `unknown` | Defaults to `unknown`. |

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
| `derived_title` | string (≤200) | `analytics`, `full` — the first meaningful line of the prompt, computed **on your machine** and truncated to 120 characters; the raw text is then deleted. Dropped in `analytics` under `privacy.prompts: never`, and in `metadata` by the mode itself. Not yet dropped by `never` under `mode: full` |
| `task_category` | enum | schema only — not populated in 0.1.0 |
| `prompt_text` | string | **`full` mode with `privacy.prompts: full` only.** Redacted first; absent entirely otherwise. |

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
| `cumulative` | boolean | Defaults to `false`. **When `true` these are running totals — the server takes the max (a gauge), it must not sum them (a counter).** Codex always emits `true`. |
| `reported_cost_usd` | number ≥ 0 | Only when the agent exposes a cost. Drives `basis: REPORTED` rather than `ESTIMATED`. |
| `plan_type` | string | Subscription plan where known — a subscription "cost" is always an API-equivalent estimate and is labelled as such. |

### Tools

#### `tool.started` / `tool.completed` / `tool.failed`

| Field | Type | `started` | `completed` | `failed` |
|---|---|---|---|---|
| `tool_name` | string ✅ | ✅ | ✅ | ✅ |
| `tool_call_id` | string | ✅ | ✅ | ✅ |
| `duration_ms` | int ≥ 0 | — | schema only | schema only |
| `error_kind` | string | — | — | schema only |

Tool **input and output are never sent**, in any mode. `error_kind` is a classification, never the
error text.

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
