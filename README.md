# AgentsTrack Collector

**See where your AI coding agents actually spend your time and your tokens — without shipping your code anywhere.**

[![npm version](https://img.shields.io/npm/v/@agentstrack/collector.svg)](https://www.npmjs.com/package/@agentstrack/collector)
[![CI](https://github.com/agentstrack/collector/actions/workflows/ci.yml/badge.svg)](https://github.com/agentstrack/collector/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org)

`@agentstrack/collector` turns the records Claude Code, Codex and OpenCode already keep on your
machine into a normalized event stream:

- **Tokens and cost** — input, cached input, cache creation, output and reasoning tokens, normalized across every agent. OpenCode's real settled provider cost comes through as `REPORTED`, not an estimate.
- **Which account paid** — a stable, opaque account key per session, so a personal login and a work one never merge into one bill.
- **What actually happened** — tool calls, commands, files changed with line counts, and the commits a session produced.
- **Nothing you didn't agree to** — prompts and code are discarded on your machine, before anything is queued for upload.

It **reads what the agent already wrote** — append-only logs for Claude Code and Codex, a read-only
SQLite query for OpenCode. It does not install hooks, it does not wrap your agent, and it **never
writes to `~/.claude/settings.json`, `~/.codex/hooks.json` or OpenCode's database**. Uninstalling is `npm rm -g` plus deleting one
directory; nothing about your agent setup changes.

**You do not have to take that on faith.** It is Apache-2.0 and this is the whole of it — the part
that runs on your machine and reads your files. Prompts and code are dropped locally, before the
upload queue, and `agentstrack sync --dry-run --print` shows you the literal JSON that would be sent
before anything is: [Verify it yourself](#verify-it-yourself).

---

## Quick start

```bash
npm install -g @agentstrack/collector       # requires Node >= 24

agentstrack login at_live_xxxxxxxx_xxxxxxxx  # key from Settings → API keys
agentstrack start                            # installs a login service and starts collecting
agentstrack status                           # confirm it is working
```

```console
$ agentstrack login at_test_0123456789abcdef_EXAMPLEonly_not_a_real_key_00000…
✓ Logged in and registered this device.
  Collector: 3f9a1e6c-1c4b-4c7e-9d0f-2a5b8c1d7e40
  Privacy:   analytics
  Config:    /Users/you/.agentstrack/config.yaml

Next: agentstrack start
```

```console
$ agentstrack status
AgentsTrack collector v0.1.0
  Logged in:   yes
  API:         https://api.agentstrack.ai
  Collector:   3f9a1e6c-1c4b-4c7e-9d0f-2a5b8c1d7e40
  Privacy:     analytics
  Queue depth: 0
  Service:     installed
  Running:     no

Agents
  ✓ claude_code    134 transcripts
  ✓ codex          13 transcripts
```

`Running: no` with `Service: installed` is normal — `Running` tracks a **foreground** collector
(`agentstrack start --foreground`), which is the only mode that writes a pidfile. The background
service is supervised by launchd/systemd; `Service: installed` is the line that matters for it.

**Your existing history is picked up automatically.** On its first pass the collector reads every
agent transcript modified in the last 7 days, from byte zero. There is no separate backfill step.

Nothing showing up? Run `agentstrack doctor`.

---

## What it collects, and what it never does

| ✅ It collects | ❌ It never does |
|---|---|
| Session ids, agent name and version, event timestamps | Read your source tree, or open any file other than agent transcripts |
| Token counts: input, cached input, cache creation, output, reasoning | Upload prompt text — unless you explicitly set `privacy.mode: full` |
| Model id, provider, stop reason | Upload file contents or diffs — unless you explicitly set `privacy.code_content: full` |
| Tool names, tool call ids, success/failure | Send tool output or command output |
| Shell commands, with secrets redacted locally | Send a command that still contains a matched credential |
| File paths, **relative to the project root by default** | Send absolute paths — which leak your username and your clients' names — unless you opt in |
| Lines added/removed per edit, computed locally from the tool input | Send the lines themselves |
| Git branch, commit SHA, additions/deletions/files changed | Send your git remote URL (only a SHA-256 of it) or commit messages and diffs |
| Locally generated session titles (`analytics` mode and above) | Send the prompt those titles were derived from |
| Your hostname, OS, arch and each detected agent's version — **once, at registration** | Store the raw hostname server-side (it is kept only as a SHA-256) |
| | Install hooks or modify `~/.claude/settings.json` / `~/.codex/hooks.json` |
| | Send `organization_id` or `user_id` — they are not in the wire format at all |
| | Watch your keyboard, your screen, or any process on your machine |

**Two facts worth repeating.**

1. **`organization_id` and `user_id` do not exist in the event envelope.** The server derives both
   from your API key. A collector cannot name its own tenant, by construction — and `npm test`
   asserts it — see [`docs/EVENT_SCHEMA.md`](./docs/EVENT_SCHEMA.md).
2. **Privacy is enforced here, before upload — not on the server.** In `metadata` mode there is no
   content to leak, because it was discarded on your laptop.

### Verify it yourself

Do not take the table above on trust. **`agentstrack sync --dry-run --print` prints the exact,
post-redaction JSON that would be uploaded, and sends nothing.** It is the single most useful command
in the tool: the privacy claims are checkable on your own machine, against your own sessions, before
a single byte leaves it.

```console
$ agentstrack sync --dry-run
10 event(s) would be sent to https://api.agentstrack.ai:

      3  tool.started
      2  model.response
      1  user.prompted
      1  file.read
      1  tool.completed
      1  file.changed
      1  command.executed

  Re-run with --print to see the full event bodies.
```

```console
$ agentstrack sync --dry-run --print
10 event(s) would be sent to https://api.agentstrack.ai:

{
  "occurred_at": "2026-08-26T10:00:00.000Z",
  "session_id": "06f3470f-d924-4552-b3ee-3f8924286cec",
  "agent": "claude_code",
  "agent_version": "2.1.241",
  "event_type": "user.prompted",
  "payload": {
    "prompt_chars": 81,
    "derived_title": "Add tests for the cost calculator",
    "repo": {
      "branch": "feature/pricing"
    }
  },
  "event_id": "fbaa5b45-7172-4b52-93c8-565aa281d51d",
  "schema_version": 1,
  "collector_id": "3f9a1e6c-1c4b-4c7e-9d0f-2a5b8c1d7e40"
}
…
```

That is a real `user.prompted` event in the default `analytics` mode. Read what is **not** there:
no `prompt_text` — the 81-character prompt it was derived from was discarded on the machine — no
`organization_id`, no `user_id`, no `project_path`. Set `privacy.prompts: never` and re-run, and
`derived_title` disappears too.

Two companion commands:

```bash
agentstrack config --show-effective     # the policy actually in force, defaults included
agentstrack doctor --json               # structured diagnostics, safe to paste into an issue
```

---

## How it works

```text
  ~/.claude/projects/<slug>/<session-uuid>.jsonl
  ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
                    │                          ~/.local/share/opencode/opencode.db
                    │  append-only files                    │
                    ▼                                       ▼
       ┌────────────────────────┐          ┌────────────────────────┐
       │        tailer          │          │      db poller         │  same 5s cycle
       │ (read-only, resumable) │          │ (READ-ONLY, no writes) │  time_updated cursors
       │ (path,inode,offset) cp │          │  in spool.db meta      │  in spool.db meta
       └───────────┬────────────┘          └───────────┬────────────┘
                   └───────────────┬───────────────────┘
                                   ▼
       ┌────────────────────────┐
       │    privacy pipeline    │  mode-based content strip
       │                        │  → 15 built-in secret rules + org rules
       │                        │  → path normalization
       │                        │  → raw content DISCARDED HERE
       └───────────┬────────────┘
                   ▼
       ┌────────────────────────┐
       │  ~/.agentstrack/       │  SQLite (WAL) — durable across crash,
       │      spool.db          │  restart and reboot
       └───────────┬────────────┘
                   ▼
       ┌────────────────────────┐
       │  batched HTTPS + gzip  │  POST /v1/events/batch, 100 events / 30s
       │  exponential backoff   │  idempotent on event_id
       └────────────────────────┘
```

**Offline is a normal state, not an error.** With no network, a blocked VPN or a dead API, the
collector keeps parsing and keeps spooling; when the network returns it drains oldest-first. Bodies
over 1 KB are gzipped.

**Restart is safe.** File read offsets live in the same SQLite database as the queue, keyed by
`(path, inode)`. A restart resumes mid-file. If a file is replaced (new inode) or truncated (offset
past the end), it is re-read from the start rather than silently skipped.

**A line the agent is still writing is never consumed.** The tailer advances its checkpoint only as
far as the **last complete newline**; a partial trailing line is left unread and picked up whole on
the next pass, once the agent has terminated it. This matters because the collector reads live
sessions: without it, every mid-write read would emit half a JSON object *and* orphan its remainder,
so both halves would fail to parse and that event would be lost. Byte offsets are computed from the
raw buffer, not from decoded text, so a multi-byte character cannot desynchronise the position
either.

**Backpressure is handled.** A `413` halves the batch size and the collector recovers it on the next
success. A `5xx`, a timeout, a `408` or a `429` is retried with jittered exponential backoff (1s
base, capped at 5 minutes). A `4xx` that is none of those means the server will never accept the
batch: **the attempt counter is incremented for the events in that batch only, and one of them is
deleted once it reaches `upload.max_retries` (default 8)**. It is not parked and it does not come
back — a poison event must not be able to block the queue forever.

Two properties of that deletion are worth stating explicitly, because both are easy to get wrong:

- **It is scoped to the failing batch.** An event sitting elsewhere in the spool cannot be destroyed
  by a batch it was not part of.
- **At least one attempt is always allowed.** `max_retries: 0` is clamped to `1`; a value of zero
  would otherwise match every never-attempted row and empty the whole queue on the first failure.

---

## Privacy

### The three modes

| | `metadata` | `analytics` *(default)* | `full` |
|---|---|---|---|
| Token counts, timings, models, costs | ✅ | ✅ | ✅ |
| Tool names and outcomes | ✅ | ✅ | ✅ |
| Commands (secret-redacted) | ✅ | ✅ | ✅ |
| File paths, line counts | ✅ | ✅ | ✅ |
| Git branch / SHA / remote **hash** | ✅ | ✅ | ✅ |
| Locally derived session titles | ❌ stripped | ✅ | ✅ |
| Error messages | ❌ stripped | ✅ | ✅ |
| Prompt text | ❌ never | ❌ never | ⚠️ only with `privacy.prompts: full` |
| File contents / diffs | ❌ never | ❌ never | ⚠️ only with `privacy.code_content: full` |

`analytics` is the honest middle: the title is computed **on your machine** from the prompt, and then
the prompt is deleted. The server receives `"fix flaky auth test"`, never the 900 words you typed.

If even the title is too much, `privacy.prompts: never` drops that too: in `analytics` it strips
`derived_title`, so nothing derived from a prompt leaves the machine, without giving up token, tool
and cost analytics the way `metadata` does. `metadata` already drops the title by mode.

`never` means never, in every mode — including `full`, where it strips both `prompt_text` and
`derived_title`. Setting it is the strongest prompt-privacy guarantee available without dropping to
`metadata`.

`full` is opt-in twice over: setting `mode: full` alone changes nothing about prompts or code —
you must also set `privacy.prompts: full` and `privacy.code_content: full`. Nothing in the product
nags you to.

### Org policy is a ceiling, never a floor

Your organization's default mode arrives in the `POST /v1/collector/register` response at login, and
is re-read from `GET /v1/collector/config` on every daemon start. **A local setting that is stricter
always wins.** An org set to `full` cannot widen a laptop configured for `metadata`; an org set to
`metadata` does clamp a laptop asking for `full`. The clamp is one shared function so login and the
daemon cannot drift.

### Built-in secret redaction

Every free-text field that survives the mode strip (`prompt_text`, `derived_title`, `message`,
`command`) passes through these 15 rules, most-specific first, on your machine:

| Rule | Catches |
|---|---|
| `anthropic_key` | `sk-ant-…` |
| `openai_key` | `sk-…`, `sk-proj-…` |
| `github_token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` |
| `github_pat` | `github_pat_…` |
| `slack_token` | `xoxb-`, `xoxa-`, `xoxp-`, `xoxr-`, `xoxs-` |
| `stripe_key` | `sk_live_`, `sk_test_`, `rk_live_`, `rk_test_` |
| `aws_access_key` | `AKIA…`, `ASIA…` |
| `google_api_key` | `AIza…` |
| `agentstrack_key` | our own `at_live_…` / `at_test_…` keys |
| `private_key` | any `-----BEGIN … PRIVATE KEY-----` block |
| `jwt` | three-segment `eyJ…` tokens |
| `bearer_header` | `Bearer <token>` → `Bearer [REDACTED]` |
| `basic_auth_url` | `https://user:pw@host` → `https://[REDACTED]@host` |
| `env_assignment` | `*SECRET*=`, `*TOKEN*=`, `*PASSWORD*=`, `*PASSWD*=`, `*APIKEY*=`, `*API_KEY*=`, `*ACCESS_KEY*=`, `*PRIVATE_KEY*=` |
| `generic_hex_secret` | bare hex strings of 40+ characters |

A match is replaced in place, and most rules substitute `[REDACTED:rule_name]`. Four do not:
`bearer_header` → `Bearer [REDACTED]` and `basic_auth_url` → `scheme://[REDACTED]@host` keep the
surrounding syntax so the shape of the command survives, `env_assignment` → `NAME=[REDACTED]` keeps
the variable name, and `generic_hex_secret` substitutes the shorter `[REDACTED:hex]`. Your
organization can add patterns server-side; a malformed org pattern is skipped rather than breaking
the collector.

Redaction is defence in depth, not the primary control. The primary control is that in `metadata`
and `analytics` modes the content is **deleted locally** and never enters the pipeline at all.

### How file paths are handled

With `file_paths: relative` (the default):

| Actual path | Uploaded as |
|---|---|
| `/Users/dana/work/api/src/auth.ts` (project root `/Users/dana/work/api`) | `src/auth.ts` |
| `/Users/dana/.zshrc` | `~/.zshrc` |
| `/etc/nginx/sites-enabled/default` | `…/sites-enabled/default` |

The project root itself (`repo.project_path`) is **dropped entirely** in `never` and `relative`
modes — it is only transmitted if you opt into `file_paths: absolute`. Repositories are correlated
by `remote_hash`, a SHA-256 of the normalized remote URL, not by path.

### Excluding a project entirely

```yaml
privacy:
  excluded_projects:
    - "~/work/client-under-nda"
    - "/Users/me/personal"
```

Prefix match on the session's working directory, `~` expands. An excluded project produces **no
events at all** — not even counts. Edit the YAML and restart the collector.

---

## Commands

| Command | What it does |
|---|---|
| `agentstrack login <api-key>` | Register this device, store the key, apply the org privacy ceiling |
| `agentstrack logout [--purge]` | Remove the stored key; `--purge` also deletes the unsent spool |
| `agentstrack start [-f]` | Install + start the login service, or run in this terminal with `-f` |
| `agentstrack stop` | Stop the collector and remove its service unit |
| `agentstrack status [--json]` | Health, queue depth, detected agents |
| `agentstrack doctor [--json]` | Diagnose setup problems; `--json` is what bug reports want |
| `agentstrack config [--path\|--show-effective]` | Print the config (API key masked) |
| `agentstrack sync [--dry-run [--print]]` | Upload queued events now, or show what would be sent |
| `agentstrack service <install\|uninstall>` | Manage the login service without starting a collector |

### `login`

```
agentstrack login <api-key> [--api-url <url>] [--label <name>]
```

The key is a **positional argument** — there is no interactive prompt and no environment variable.
`--api-url` points at a self-hosted instance; `--label` names this machine in the dashboard.
Registration is idempotent on (user, hostname hash), so re-running `login` on the same machine reuses
the existing collector instead of fragmenting its history. The config file is written mode `600`, in
a directory created mode `700`.

The registration payload is `hostname`, `label`, `os`, `arch`, the collector's own version, and one
entry per configured agent: `{ agent, version }`. The **agent version is the real one**, read out of
a transcript the agent already wrote (`2.1.247`, say, from Claude Code's `version` field). Where an
adapter cannot cheaply establish a version at detection time the field is simply **omitted** rather
than filled with a placeholder, so a missing version in the dashboard means "not reported", never
"not detected".

Both shipping adapters report a real version. Claude Code reads it from a transcript
(e.g. `2.1.247`); Codex reads `session_meta.cli_version` from its newest rollout
(e.g. `0.149.0-alpha.4.3`). The same value is attached to every event as `agent_version`.

If your local privacy mode is stricter than the org's, login says so and keeps yours:

```
  Privacy:   metadata (your local setting; org allows analytics)
```

### `start` / `stop`

`agentstrack start` writes a **launchd** agent on macOS (`~/Library/LaunchAgents/ai.agentstrack.collector.plist`)
or a **systemd user unit** on Linux (`~/.config/systemd/user/agentstrack.service`), loads it, and
returns. Neither needs root. `-f` / `--foreground` runs in the terminal instead — best for a first
run, and the only mode where `status` reports `Running: yes`.

`agentstrack stop` removes the service unit *and* signals a foreground collector. There is no
"stop but keep the unit"; use `agentstrack service install` to put it back.

### `doctor`

```console
$ agentstrack doctor
Configuration
  ✓ config exists at /Users/you/.agentstrack/config.yaml
  ✓ API key present
  ✓ device registered

Agents
  ✓ claude_code transcripts found
    225 file(s) modified in the last 7 days
  ✓ codex transcripts found
    3 file(s) modified in the last 7 days

Connectivity
  ✗ API reachable at https://api.agentstrack.ai
    fetch failed

Queue
  ✓ queue depth 0
    log: /Users/you/.agentstrack/collector.log

1 problem(s) found.
```

Exit code is non-zero when there is a problem, so it works in a monitoring check.
`agentstrack doctor --json` prints the structured form, which is what the bug template asks for:

```json
{
  "version": "0.1.0",
  "node": "v22.22.0",
  "platform": "darwin-arm64",
  "configured": true,
  "logged_in": true,
  "collector_id": "3f9a1e6c-1c4b-4c7e-9d0f-2a5b8c1d7e40",
  "privacy_mode": "analytics",
  "api_url": "https://api.agentstrack.ai",
  "api": { "reachable": true, "privacy_mode": "analytics" },
  "queue_depth": 0,
  "running": false,
  "service_installed": true,
  "agents": [
    { "agent": "claude_code", "installed": true, "healthy": true, "files_tracked": 134, "note": null },
    { "agent": "codex", "installed": true, "healthy": true, "files_tracked": 13, "note": null }
  ],
  "log_path": "/Users/you/.agentstrack/collector.log"
}
```

It contains no API key, no prompt, no path inside a project — it is safe to paste into an issue.

### `config`

`agentstrack config` prints the file as it is on disk with the key masked. `--path` prints the path
only. `--show-effective` prints the config **after every default is applied** — the policy the
collector actually runs with:

```console
$ agentstrack config --show-effective
api_url: https://api.agentstrack.ai
privacy:
  mode: analytics
  prompts: local_summary_only
  code_content: never
  file_paths: relative
  shell_arguments: redact_secrets
  excluded_projects: []
tracking:
  idle_timeout_seconds: 120
  git_metadata: true
  process_metrics: true
  agents:
    - claude_code
    - codex
    - opencode
upload:
  batch_size: 100
  interval_seconds: 30
  max_retries: 8
```

There is no `config set` — edit the YAML. An invalid config is a **hard error**, never a silent
fallback to defaults, so a typo cannot quietly widen your privacy mode.

### `sync`

Drains the spool once and exits — useful after a network outage, or from a cron job on a machine
where you would rather not run a daemon. It does **not** take a time window; the daemon's own scan is
what reads new transcript lines.

```console
$ agentstrack sync
✓ Queue is already empty.

$ agentstrack sync --dry-run
✓ Nothing queued — nothing would be sent.
```

With a backlog it prints `Uploading <n> queued events…` and then either `✓ Uploaded <n> events.` or,
if some remain, a warning naming the log — and exits non-zero, so it is safe to run from cron.

`--dry-run` sends nothing at all and prints a breakdown by event type; `--print` adds the full
post-redaction JSON body of each one — see [Verify it yourself](#verify-it-yourself). Both inspect
the head of the queue, up to `upload.batch_size` events, so `100 event(s) would be sent` on a large
backlog means "the next batch", not "the whole spool" — `agentstrack status` reports the true depth.

---

## Configuration

`~/.agentstrack/config.yaml`, mode `600` because it holds an API key. Set `AGENTSTRACK_HOME` to
relocate the whole directory (config, spool, log, pidfile). Every key has a default — an empty file
is a valid config. This is the complete set:

```yaml
# --- Connection ---------------------------------------------------------
api_url: https://api.agentstrack.ai      # change for a self-hosted instance
api_key: at_live_xxxxxxxxxxxxxxxx_xxxx   # written by `agentstrack login`. Never commit.
collector_id: 3f9a1e6c-…                 # assigned by the server at registration

# --- Privacy ------------------------------------------------------------
privacy:
  # metadata  | analytics (default) | full     — see the table above
  mode: analytics

  # never | local_summary_only (default) | full
  # `full` is what keeps `mode: full` from uploading prompt text unless you also
  # ask for it here. `never` suppresses prompt text in every mode, and in
  # `analytics` it additionally drops the locally derived `derived_title`, so
  # nothing derived from a prompt leaves the machine at all. Under `mode: full`
  # it does NOT drop `derived_title` — see the privacy section.
  prompts: local_summary_only

  # never (default) | full
  # `never` drops file contents and diffs in EVERY mode, so opting into `full`
  # prompts does not silently opt into shipping source code.
  code_content: never

  # never | relative (default) | absolute
  # relative: paths relative to the project root; `~` for home; last two
  # segments for anything else. The project root is only sent under `absolute`.
  file_paths: relative

  # never | redact_secrets (default) | full
  # `never` truncates a command to its first whitespace token. The other two
  # keep the command line; secret redaction is applied either way.
  shell_arguments: redact_secrets

  # Prefix match on the session's working directory. `~` expands.
  # An excluded project produces no events of any kind.
  excluded_projects: []

# --- Tracking -----------------------------------------------------------
tracking:
  # Read by the server, not by the collector — see "Roadmap". 30–3600.
  idle_timeout_seconds: 120

  # Read git branch, project root and a HASH of the remote; poll `git log` for
  # commits made during a session. `false` means no git process is ever spawned.
  git_metadata: true

  # Not implemented yet — see "Roadmap".
  process_metrics: true

  # Which adapters to run. Removing one stops it being read entirely.
  agents:
    - claude_code
    - codex

# --- Upload -------------------------------------------------------------
upload:
  batch_size: 100        # events per request. 1–500 (server caps at 500).
  interval_seconds: 30   # seconds between flushes. 5–600.
  max_retries: 8         # non-retryable failures before an event is DELETED. 0–20;
                         # 0 is clamped to 1, since "zero attempts allowed" would
                         # match every queued event on the first failure.
```

Environment overrides: `AGENTSTRACK_HOME` (all local state), `CLAUDE_CONFIG_DIR` (default
`~/.claude`), `CODEX_HOME` (default `~/.codex`), `OPENCODE_DATA_DIR` (default
`$XDG_DATA_HOME/opencode`, falling back to `~/.local/share/opencode`) and `OPENCODE_DB` (the
database filename or an absolute path — the same override OpenCode itself honours).

---

## Supported agents

| Agent | Status | Reads |
|---|---|---|
| **Claude Code** | ✅ Stable | `~/.claude/projects/<slug>/<session-uuid>.jsonl` |
| **Codex** | ✅ Stable | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` |
| **OpenCode** | ✅ Stable | `~/.local/share/opencode/opencode.db` — SQLite, opened **read-only** |
| Gemini CLI · Cursor · Cline · Copilot CLI | 🗓 Planned | ids reserved in the schema, no adapter yet |

Per-signal honesty — the adapters do not produce identical data, because the agents do not record
identical things:

| Signal | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Session start | ➖ inferred from the first event | ✅ from `session_meta` | ✅ from the `session` row |
| Session end | ➖ inferred | ➖ inferred | ✅ on archive or compaction |
| Prompts / titles | ✅ | ✅ | ✅ (OpenCode names its own sessions) |
| Per-response token usage | ✅ `model.response` with full cache breakdown | ➖ cumulative snapshots only | ➖ cumulative per-session totals only |
| **Provider-reported cost** | ➖ estimated from a rate card | ➖ estimated | ✅ **`REPORTED` — the real settled charge** |
| Turn boundaries | ➖ not logged | ✅ `agent.turn.started` / `.ended` | ➖ not emitted |
| Tool calls | ✅ | ✅ (incl. `custom_tool_call`) | ✅ terminal event with a real duration |
| Commands | ✅ from `Bash` tool input | ✅ with exit code and duration | ✅ from the `bash` tool's input |
| File changes + line counts | ✅ from `Edit`/`Write`/`NotebookEdit` inputs | ✅ parsed from the `apply_patch` body | ✅ from `edit`/`write` tool inputs |
| File reads | ✅ from the `Read` tool | ➖ heuristic, from `cat`/`head`/`tail`/`sed`/`nl`/`bat`/`less` | ✅ from the `read` tool |
| Agent errors | ➖ not logged | ✅ `error` | ➖ not emitted |
| Commits | ✅ (from `git log`, not the transcript) | ✅ (same) | ✅ (same) |
| Plan / subscription type | ➖ | ✅ `plan_type` | ➖ |
| Account attribution | ✅ from `~/.claude.json` | ➖ no account file | ✅ from `account.json`, per provider |

Every adapter is read-only. Adapter formats drift between agent releases: an unparseable line is
skipped, never fatal to the file.

### OpenCode is a live database, not a log

OpenCode keeps sessions, messages and message parts in SQLite — the same file its UI is writing to
while you work. So this adapter does not tail; it polls, on the same 5-second cycle as the tailer,
and it takes deliberate care not to be the reason your editor stutters or your history breaks:

- opened `readonly` **and** `fileMustExist`, with `PRAGMA query_only` — a bug here cannot write,
  migrate or create anything;
- `PRAGMA busy_timeout` so a concurrent OpenCode write makes us wait briefly instead of failing;
- one short query at a time, then the handle is closed. No long transactions, ever.

Because `(path, inode, offset)` means nothing to a database, resumption uses three `time_updated`
cursors in the collector's own spool. A first-ever run reaches back 7 days, the same horizon the
tailer uses for transcripts.

### Which account did this?

One machine often drives several accounts. Each session carries a stable, opaque `account.key`
(Claude Code's `accountUuid`; OpenCode's `<serviceID>:<accountId>`) so their costs never merge. The
readable half — email, organization name — is PII and is stripped in `metadata` mode, where sessions
still split correctly but the account shows as opaque.

**The credential is never read.** OpenCode's `account.json` stores a live API key next to the account
id; only `id` and `serviceID` are touched, and `auth.json` is never opened at all.

**Live events only.** These files record who is signed in *now* and are rewritten on account switch,
so events that predate the collector's start carry **no** account rather than today's — a
retroactive guess would look exactly like a fact.

Want an agent that is not here? Open an
[agent support request](https://github.com/agentstrack/collector/issues/new?template=agent_support.yml),
or write it — see [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Self-hosting

The collector speaks plain REST over HTTPS. Point it anywhere:

```bash
agentstrack login <api-key> --api-url https://agentstrack.internal.example.com
```

Or set `api_url` in `config.yaml` and restart. These are the only endpoints it calls:

| Method | Path | When |
|---|---|---|
| `POST` | `/v1/collector/register` | `login`, and once on daemon start if `collector_id` is missing |
| `GET` | `/v1/collector/config` | `doctor`, and each daemon start — org privacy ceiling + redaction rules. Not called by `login`: the register response already carries the ceiling |
| `POST` | `/v1/collector/health` | Every 60s while running — queue depth, version, detected agents |
| `POST` | `/v1/events/batch` | Every `upload.interval_seconds`, or when the queue reaches `batch_size` |

Authentication is `Authorization: Bearer <api_key>` on every request. Batch bodies over 1 KB are
gzipped (`content-encoding: gzip`).

---

## Troubleshooting

**Start here: `agentstrack doctor`.** It checks every failure mode below.

### No sessions appearing

1. `agentstrack status` — is `Service: installed` (or `Running: yes` for a foreground run), and does
   each agent show a transcript count above zero?
2. Do the transcripts exist and are they recent? The collector only reads files modified in the last
   **7 days**:
   ```bash
   ls -lt ~/.claude/projects/*/*.jsonl | head
   find ~/.codex/sessions -name '*.jsonl' -mtime -7 | head
   ```
3. Is the project on your exclusion list? `agentstrack config --show-effective | grep -A3 excluded`
4. Is the agent enabled under `tracking.agents`?
5. Is anything queued but stuck? `agentstrack sync --dry-run` shows the head of the queue.

### The queue is not draining

`agentstrack status` shows `Queue depth` climbing. Check `agentstrack doctor`, then the log:

| Symptom | Cause | Fix |
|---|---|---|
| `401` in the log | Key revoked or wrong | `agentstrack login <new-key>` |
| `403` | Key lacks ingest permission | Issue a new key |
| `fetch failed`, `ETIMEDOUT` | Network, VPN or proxy | Set `HTTPS_PROXY`; events keep spooling meanwhile |
| `Server rejected the batch as too large` | Batch above the server's limit | Automatic — batch size halves and recovers |
| `Batch permanently rejected: … (dropped N)` | Non-retryable `4xx` | N events **in that batch** hit `max_retries` and were deleted. Nothing outside the batch is touched. Check the API version matches the collector's schema. |

Retryable failures never lose anything: `spool.db` is durable across restarts and reboots, and
draining resumes automatically.

### Permission errors

```
EACCES: permission denied, open '/Users/you/.claude/projects/…/abc.jsonl'
```

The collector runs as **you** and needs read access to the agent log directories plus read/write on
`~/.agentstrack`. It never needs root — do not run it with `sudo`, since a root-owned spool is the
usual cause of this error showing up later.

```bash
ls -ld ~/.agentstrack ~/.claude/projects ~/.codex/sessions
```

`~/.agentstrack` is created mode `700`, `config.yaml` and `spool.db` (with its `-wal` / `-shm`
files) mode `600` — the collector sets those itself, so you should not have to. If an older install
or a `sudo` run left them wider, this puts them back:

```bash
chmod 700 ~/.agentstrack && chmod 600 ~/.agentstrack/config.yaml ~/.agentstrack/spool.db*
```

On macOS, if your agent directories sit under Documents or Desktop, grant your terminal (and, for the
service, `node`) Full Disk Access in System Settings → Privacy & Security.

### Reading the log

```bash
tail -f ~/.agentstrack/collector.log
grep -i "error\|failed\|rejected" ~/.agentstrack/collector.log | tail -20
```

The log records counts, queue depths and `event_id`s — never payloads, prompts, code or keys. That is
what makes it safe to attach to an issue. Please attach `agentstrack doctor --json` too.

### Complete reset

```bash
agentstrack stop
rm -rf ~/.agentstrack          # config, spool, log, pidfile — all local state
agentstrack login <api-key>
agentstrack start
```

---

## Roadmap

Honest list of things that are **not** in 0.1.0, so you do not go looking for them.
[ROADMAP.md](./ROADMAP.md) has the same list with the design constraints and what "help wanted"
means for each.

- **Backfill window control** (`sync --since 30d`). Today the daemon reads whatever was modified in the last 7 days, and that window is not configurable.
- **`config get` / `config set` / `config edit`** — edit the YAML by hand for now.
- **`--verbose` logging** and per-run agent selection (`start --agent codex`); use `tracking.agents`.
- **Local time accounting.** Human-active / agent-active / idle windows are derived server-side from the event stream; `tracking.idle_timeout_seconds` is parsed by the collector but not used by it.
- **Process metrics.** `tracking.process_metrics` is accepted and ignored.
- **`session.ended`, `heartbeat`, `model.request` and `git.branch_changed`** are in the schema but no adapter emits them yet.
- **Local task classification** (`task_category`) — the field exists in the schema; the collector only derives a title.
- **Windows.** The service installer covers launchd and systemd only; `--foreground` works anywhere Node 24+ does.
- **Content-derived `event_id`.** Ids are random per enqueue, so retrying a batch is safe but re-reading a truncated transcript would create duplicates.
- **`MultiEdit`.** The Claude Code adapter derives file changes from `Edit`, `Write`, `NotebookEdit` and `Read`; a `MultiEdit` call is still recorded as `tool.started`/`tool.completed`, but produces no `file.changed` events and no line counts.

---

## Contributing

The single highest-value contribution is **a new agent adapter**, and it is smaller than it sounds:
one file implementing three methods — `detect()`, `health()`, `normalize()` — plus a redacted fixture
and a test. There is deliberately no `installHooks()`; if an agent cannot be observed by reading files
it already writes, open an issue before writing code.

[CONTRIBUTING.md](./CONTRIBUTING.md) walks the whole thing: dev setup is `npm install && npm test`,
and running against a local API is one environment variable.

- 🐛 [Bug report](https://github.com/agentstrack/collector/issues/new?template=bug_report.yml)
- 💡 [Feature request](https://github.com/agentstrack/collector/issues/new?template=feature_request.yml)
- 🤖 [Request an agent](https://github.com/agentstrack/collector/issues/new?template=agent_support.yml)
- 🙋 [Getting help](./SUPPORT.md) — where a question goes versus a bug versus a vulnerability
- 🗺 [Roadmap](./ROADMAP.md) — the known gaps, and which are good first issues
- 🏛 [Governance](./GOVERNANCE.md) — how decisions get made and how to become a maintainer
- 🔒 [Security policy](./SECURITY.md) — report vulnerabilities privately
- 📜 [Code of Conduct](./CODE_OF_CONDUCT.md)

## License

[Apache License 2.0](./LICENSE) © AgentsTrack contributors.

The collector is open source and always will be. It is the part that runs on your machine and reads
your files — you should be able to audit every line of it.
