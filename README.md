# AgentsTrack Collector

**See where your AI coding agents actually spend your time and your tokens — without shipping your code anywhere.**

[![npm version](https://img.shields.io/npm/v/@agentstrack/collector.svg)](https://www.npmjs.com/package/@agentstrack/collector)
[![CI](https://github.com/agentstrack/collector/actions/workflows/ci.yml/badge.svg)](https://github.com/agentstrack/collector/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org)

`@agentstrack/collector` turns the records Claude Code, Codex, OpenCode, Gemini CLI and Antigravity
already keep on your machine into a normalized event stream:

- **Tokens and cost** — input, cached input, cache creation, output and reasoning tokens, normalized across every agent. OpenCode's real settled provider cost comes through as `REPORTED`, not an estimate.
- **Which account paid** — a stable, opaque account key per session, so a personal login and a work one never merge into one bill.
- **What actually happened** — tool calls, commands, files changed with line counts, and the commits a session produced.
- **Nothing you didn't agree to** — prompts and code are discarded on your machine, before anything is queued for upload.

It **reads what the agent already wrote** — append-only logs for Claude Code, Codex, Gemini CLI and
Kimi Code, a read-only SQLite query for OpenCode, a private copy of each Antigravity database. It does not install hooks, it does not wrap your agent, and it **never
writes to `~/.claude/settings.json`, `~/.codex/hooks.json` or OpenCode's database**. Uninstalling is `npm rm -g` plus deleting one
directory; nothing about your agent setup changes.

**You do not have to take that on faith.** It is Apache-2.0 and this is the whole of it — the part
that runs on your machine and reads your files. Prompts and code are dropped locally, before the
upload queue, and `agentstrack sync --dry-run --print` shows you the literal JSON that would be sent,
without uploading any of it: [Verify it yourself](#verify-it-yourself).

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
AgentsTrack collector v0.7.0
  Logged in:   yes
  API:         https://api.agentstrack.ai
  Collector:   3f9a1e6c-1c4b-4c7e-9d0f-2a5b8c1d7e40
  Privacy:     analytics
  Queue depth: 0
  Service:     installed
  Running:     yes

Agents
  ✓ claude_code    134 sessions
  ✓ codex          13 sessions
```

The background service runs `agentstrack start --foreground` under launchd/systemd, so a running
service shows `Running: yes`. `Running: no` with `Service: installed` means the supervisor has not
started it yet or it exited; check the log.

**Your existing history is picked up automatically.** On its first pass the collector reads every
agent transcript modified in the last 7 days (`tracking.max_age_days`), from byte zero. There is no
separate backfill step; raise `max_age_days` to import older history.

Nothing showing up? Run `agentstrack doctor`.

---

## What it collects, and what it never does

| ✅ It collects | ❌ It never does |
|---|---|
| Session ids, agent name and version, event timestamps | Read your source tree, or open any file other than agent transcripts — and, only if you opt in with `tracking.open_island_rate_limits`, Open Island's `/tmp/open-island-rl.json` |
| Token counts: input, cached input, cache creation, output, reasoning | Upload prompt text — unless you explicitly set `privacy.mode: full` |
| Model id, provider, stop reason | Upload file contents or diffs — unless you explicitly set `privacy.code_content: full` |
| Tool names, tool call ids, success/failure | Send tool output or command output |
| Shell commands: the **whole command line** in the default `analytics` mode (and `full`), secret-redacted locally; the binary name only in `metadata` | Send a command that still contains a matched credential |
| File paths, **relative to the project root** in every mode (the default `file_paths: relative`) | Send absolute paths — which leak your username and your clients' names — unless you opt in |
| Lines added/removed per edit, computed locally from the tool input | Send the lines themselves |
| Git branch, commit SHA, additions/deletions/files changed | Send your git remote URL (only a SHA-256 of it) or commit messages and diffs |
| A session title — the first line of the prompt, secret-redacted and then capped at 120 chars (`analytics` mode and above) | Send the rest of the prompt those titles were taken from |
| Your hostname, OS and release, arch, Node version, a coarse machine kind (`workstation` / `server` / `container` / `ci`) and each detected agent's version — at registration and with each health report | Show your hostname or IP address in the product — see [Machine info](#machine-info) |
| That local redaction fired: which pattern matched and how many times (`secrets_redacted`), in every privacy mode | Send the secret it matched — not the text, not a prefix of it, not a hash of it, not the characters around it |
| Plan headroom: the used % and reset time of your plan's rate-limit windows, as Codex reports them (Claude Code only via the Open Island opt-in) | Send Codex's credit balance |
| Which account a session ran under: an opaque key in every mode, plus the account's email or display name and org name in `analytics` and `full` | Send any credential from the agent's auth files |
| Which skill, sub-agent type or workflow a Claude Code session invoked, and which events came from a sub-agent | Copy the `Agent` call's prompt or a workflow script's body out of the call (a sub-agent transcript's own opening prompt follows `privacy.prompts` like any other prompt) |
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
post-redaction JSON that would be uploaded, and uploads none of it.** It scans your transcripts the
way the daemon would, against a throwaway copy of the spool, so it shows what is queued plus what the
next scan would add — and writes nothing back. The one request it makes is
`GET /v1/collector/config`, so the org policy it applies is the one the daemon would. It is the single
most useful command in the tool: the privacy claims are checkable on your own machine, against your
own sessions, before a single event leaves it.

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
  ~/.gemini/tmp/<project>/chats/session-*.jsonl
  ~/.kimi/sessions/<md5>/<session>/wire.jsonl            ~/.local/share/opencode/opencode.db
                    │                          ~/.gemini/antigravity-cli/conversations/*.db
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
       │                        │  → built-in secret rules + org rules
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
`(path, inode)`, and a chunk's offset is committed in the **same transaction** as the events parsed
from it — a crash or a full disk between "read" and "queued" re-reads those lines rather than losing
them. A restart resumes mid-file. If a file is replaced (new inode) or truncated (offset past the
end), it is re-read from the start rather than silently skipped. Re-reading never double-counts:
every event's `event_id` is derived from the file, the line's byte offset and the line's content, so
the server's dedupe absorbs a replay. A Claude Code `model.response` is keyed on its `message.id`
instead, since one response spans several lines; an idle `session.ended` on the agent, session and
last-activity time; a `git.commit` on the session and the commit SHA. OpenCode's events, which come
from database rows rather than lines, are the only ones that still get a random id.

**Big files are streamed, not slurped.** Transcripts are read in 4 MB chunks with the partial line
carried across the boundary, at most 64 MB per file per scan so a first import keeps yielding to the
upload loop. A single line over 8 MB is skipped to the next newline and counted in the log — never
buffered, never logged. One unreadable file is logged and skipped; it cannot stall the other files.

**A line the agent is still writing is never consumed.** The tailer advances its checkpoint only as
far as the **last complete newline**; a partial trailing line is left unread and picked up whole on
the next pass, once the agent has terminated it. This matters because the collector reads live
sessions: without it, every mid-write read would emit half a JSON object *and* orphan its remainder,
so both halves would fail to parse and that event would be lost. Byte offsets are computed from the
raw buffer, not from decoded text, so a multi-byte character cannot desynchronise the position
either.

**Backpressure is handled, once per wave.** Batches go out `upload.concurrency` at a time, and the
failure policy runs on the wave's collected outcomes rather than inside each request — so four
failing siblings cost one backoff step, not four, and a sibling's success cannot undo a `413`
shrink. A `413` halves the batch size once (never above the server's `max_batch_events`) and it
creeps back up on success. A `400` or `422` on a batch of more than one event halves it the same way,
so one bad event ends up alone and only it is struck. A `5xx`, a timeout, a `408` or a `429` sets the next upload time with
jittered exponential backoff (1s base, capped at 5 minutes, or the server's `Retry-After` if longer)
— the daemon never sleeps on it, so tailing continues meanwhile. A daemon tick sends at most five
waves before scanning again. Three responses **pause** uploads instead: a `401`/`403` (the key, not
the events, is the problem), a `200` whose `quota.exceeded` says the org is over its monthly cap,
and a `200` that rejects every event as malformed (the collector is probably older than the server).
Nothing is acked or dropped while paused; `agentstrack status` shows the reason, and the pause lifts
by itself once a wave succeeds. A `4xx` that is none of those means the server will never accept the
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
| Commands | binary name only | ✅ full command line, secret-redacted | ✅ full command line, secret-redacted |
| File paths (relative to the project), line counts | ✅ | ✅ | ✅ |
| Git branch / SHA / remote **hash** | ✅ | ✅ | ✅ |
| Locally derived session titles, sub-agent descriptions | ❌ stripped | ✅ | ✅ |
| Error messages | ❌ stripped | ✅ | ✅ |
| Account email / display name and org name | ❌ stripped (opaque key only) | ✅ | ✅ |
| Prompt text | ❌ never | ❌ never | ⚠️ only with `privacy.prompts: full` |
| File contents / diffs | ❌ never | ❌ never | ⚠️ only with `privacy.code_content: full` |

Be clear about what the default sends. In `analytics`, a shell command is the **whole command line**
— arguments, hostnames, paths and all — with the built-in and org secret rules applied; set
`privacy.shell_arguments: never` to send only the binary name, which is what `metadata` always does.
A file path is relative to the project root (`src/auth.ts`) in every mode unless you change
`privacy.file_paths`. The account's label — usually an email — travels with `session.started` and
`user.prompted` in `analytics` and `full`. Short labels (tool, skill and workflow names, models,
branch and project names, abort reasons) are sent in every mode, secret-redacted.

`analytics` is the honest middle: the title is computed **on your machine** from the prompt, and then
the prompt is deleted. The server receives `"fix flaky auth test"`, never the 900 words you typed.
The prompt is redacted **before** the title is cut out of it, so the cut can only ever land inside a
`[REDACTED:…]` marker and never through the middle of a key. Before 0.4.1 it was cut first, which
could ship half of a secret — see the CHANGELOG.

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
is re-read from `GET /v1/collector/config` when the daemon starts and every 10 minutes after (every
minute until the first read succeeds). **A local setting that is stricter always wins.** An org set
to `full` cannot widen a laptop configured for `metadata`; an org set to `metadata` does clamp a
laptop asking for `full`. The clamp is one shared function so login and the daemon cannot drift.

The last policy fetched is kept in `spool.db`, so a collector that starts with no network still
applies it. A mode the collector does not recognise counts as `metadata`. `config.yaml` keeps your
own setting; the clamp is applied on every run.

**Until a policy is known, nothing is collected.** Privacy is applied as events are queued, so a
registered device that has never fetched its org policy — and has no readable stored copy — reads no
transcripts and uploads nothing until `GET /v1/collector/config` succeeds once. Read offsets do not
move meanwhile, so nothing is lost; the first scan after the fetch catches up. The log says
`No org policy yet (server config never fetched) — not reading or uploading until it is`.

### Built-in secret redaction

Every free-text field (`prompt_text`, `derived_title`, `message`, `command`, `description`) and every
label that travels in all modes (`tool_name`, `skill`, `subagent_type`, `agent_type`, `agent_kind`,
`agent_id`, `workflow_name`, `model`, `plan_type`, `stop_reason`, `error_kind`, `abort_reason`,
`branch`, `project_name`, and `git.branch_changed`'s `from` / `to`) passes through these rules,
most-specific first, on your machine:

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
| `google_oauth_token` | `ya29.…` |
| `npm_token` | `npm_…` |
| `gitlab_token` | `glpat-…` |
| `huggingface_token` | `hf_…` |
| `sendgrid_key` | `SG.….…` |
| `agentstrack_key` | our own `at_live_…` / `at_test_…` keys |
| `private_key` | any `-----BEGIN … PRIVATE KEY-----` block |
| `jwt` | three-segment `eyJ…` tokens |
| `bearer_header` | `Bearer <token>` → `Bearer [REDACTED]` |
| `basic_auth_header` | `Authorization: Basic <credentials>` |
| `token_auth_header` | `Authorization: Token <token>` |
| `cookie_header` | `Cookie:` / `Set-Cookie:` — the whole header value |
| `basic_auth_url` | `https://user:pw@host` → `https://[REDACTED]@host` |
| `env_assignment` | `*SECRET*=`, `*TOKEN*=`, `*PASSWORD*=`, `*PASSWD*=`, `*APIKEY*=`, `*API_KEY*=`, `*ACCESS_KEY*=`, `*PRIVATE_KEY*=` |
| `inline_password_flag` | `--password=SECRET`, `--password "SECRET"`; `-pSECRET` on `mysql`, `mongosh`, `sshpass` and similar |
| `secret_flag` | `--token`, `--api-key`, `--apikey`, `--secret`, `--*-secret`, `--secret-key`, `--auth-token`, `--access-token` |
| `curl_user` | `curl -u user:pass` / `--user user:pass` |
| `secret_assignment` | `key=value`, `key: value`, `?key=value&` and JSON `"key": "value"` (escaped JSON too), any case, where the key ends in `secret`, `token`, `password`, `pwd`, `api_key`, `access_key`, `private_key` or `secret_key`; `pass` / `auth` only with `=` or as a quoted JSON key |
| `generic_hex_secret` | bare hex strings of 40+ characters |

Prefixed tokens are matched even inside identifiers — `mcp__npm_<token>__get`, `srv_hf_<token>` —
because `_` would otherwise hide them from a word boundary.

A match is replaced in place, and most rules substitute `[REDACTED:rule_name]`. Some keep the
surrounding syntax so the shape of the command survives: `bearer_header` → `Bearer [REDACTED]`,
`basic_auth_url` → `scheme://[REDACTED]@host`, `env_assignment` → `NAME=[REDACTED]`, and the header,
flag and assignment rules keep their header, flag or key (`--password=[REDACTED]`,
`Cookie: [REDACTED]`, `"apiKey": [REDACTED]`). `generic_hex_secret` substitutes the shorter
`[REDACTED:hex]`. Fields with a length cap (`message` 1000, `abort_reason` 50, `derived_title` 120)
are cut **after** redaction, never before.

Your organization can add patterns server-side. An org pattern that is malformed, longer than 256
characters, uses a backreference, uses a common catastrophic nested-quantifier shape (`(a+)+`,
`(a|aa)+`, `((a+)b)+`), or has more than one unbounded quantifier (`*`, `+`, `{n,}`, `{n,m}` with
m ≥ 100) is skipped and logged by its index and the reason — never its pattern. These checks are a
heuristic, not a proof, so org patterns are also matched against at most the first 64 KB of any
value.

Redaction is defence in depth, not the primary control. The primary control is that in `metadata`
and `analytics` modes the content is **deleted locally** and never enters the pipeline at all.

### What a redaction reports

When a rule fires, the event carries `secrets_redacted` — a list of `{ kind, count }`, sorted by
kind, absent when nothing fired:

```json
"secrets_redacted": [{ "kind": "aws_access_key", "count": 1 }]
```

Plainly: **we report that a secret-shaped string was found and which pattern matched it. We never
send the value.** Not the matched text, not a prefix of it, not a hash of it, not the surrounding
context — there is nothing in the payload to reverse. A rule your organization added reports as the
single generic kind `org_rule`, because a rule name (`acme_prod_db_password`) can itself describe
the shape of your secrets.

This travels in **every** mode, `metadata` included: the tally is computed before the mode strip
deletes the text it was computed from. A count is metadata; the prompt it came from is not. And
`metadata` is exactly the mode where a team most wants to know that a live credential was pasted
into an agent — the point being to go rotate it, which needs no copy of it.

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

### Machine info

`login` (registration) and the daemon's health report, once a minute, send: `hostname`, `os`
(`darwin` / `linux` / `win32`), `os_release` (`os.release()`), `arch`, and
`machine_kind` — `ci` when `CI`, `GITHUB_ACTIONS` or `GITLAB_CI` is set; `container` when
`/.dockerenv` exists or `/proc/1/cgroup` mentions docker, containerd or kubepods; `workstation` on
macOS and Windows, or Linux with `DISPLAY` / `WAYLAND_DISPLAY` / a graphical `XDG_SESSION_TYPE`;
`server` for headless Linux; `unknown` otherwise. It is derived from those probes only.

The server keeps the hostname (raw, plus a SHA-256 that keys registration) and the IP address it
saw the register, health and upload requests come from, **for operations and abuse prevention
only** — telling one machine's collector from another, and shutting off a key that is being abused.
Neither is returned by any user-facing endpoint or shown anywhere in the product; the dashboard
identifies a device by its label and machine kind. Everything else in the list (OS, arch, kind,
versions) is what the device page shows.

### Excluding a project entirely

```yaml
privacy:
  excluded_projects:
    - "~/work/client-under-nda"
    - "/Users/me/personal"
```

Prefix match on the session's working directory (or the repository path an adapter reports), on
whole path segments — `~/work/api` excludes `~/work/api/src` but not `~/work/api-docs`. `~` expands.
An excluded project produces **no events at all** — not even counts. Edit the YAML and restart the
collector.

**It fails closed.** While the list is non-empty, an event from any adapter that names neither a
working directory nor a repository path is dropped, because it cannot be shown not to belong to an
excluded project. The log records how many were dropped.

Commit reporting follows the same rule. A commit is not reported if any file it changes is under an
excluded path, so a monorepo subfolder on the list keeps its commits out of the feed even when
another project in the same repository is tracked.

---

## Commands

| Command | What it does |
|---|---|
| `agentstrack login <api-key>` | Register this device, store the key, apply the org privacy ceiling |
| `agentstrack logout [--purge]` | Remove the stored key; `--purge` also deletes the unsent spool |
| `agentstrack start [-f] [--agent <id>]` | Install + start the login service, or run in this terminal with `-f`; `--agent` (with `-f` only) limits the run to those agents |
| `agentstrack stop` | Stop the collector and remove its service unit |
| `agentstrack status [--json]` | Health, queue depth, detected agents. Exits 0 even when not configured |
| `agentstrack doctor [--json]` | Diagnose setup problems; `--json` is what bug reports want |
| `agentstrack summary [--days N] [--json]` | Your own totals from AgentsTrack for the last N days (1–30, default 7) |
| `agentstrack config [--path\|--show-effective]` | Print the config (API key masked) |
| `agentstrack sync [--full]` | Upload queued events now; `--full` re-reads every transcript first |
| `agentstrack sync --dry-run [--print]` | Scan and show what would be sent, without uploading or saving anything |
| `agentstrack service <install\|uninstall>` | Manage the login service without starting a collector |

`--verbose`, before or after any command, adds event counts per scan, batch sizes and server status
codes to the log and to stderr (prefixed `[verbose]`). It never prints payloads, prompts, paths or
keys.

### `login`

```
agentstrack login <api-key> [--api-url <url>] [--label <name>]
```

The key argument is **optional**. Passing it on the command line leaves it in your shell history and
in `ps`, so `login` also reads `AGENTSTRACK_API_KEY`, or prompts on the terminal (echo off), or takes
the key on stdin — `agentstrack login < key.txt`. `--api-url` points at a self-hosted instance and
**must be `https`** (plain `http` is accepted only for `localhost`); `login` prints the URL it is
about to use. `--label` names this machine in the dashboard.
Registration is idempotent on (user, hostname hash), so re-running `login` on the same machine reuses
the existing collector instead of fragmenting its history. The config file is written mode `600`, in
a directory created mode `700`.

The registration payload is `hostname`, `label`, `os`, `os_release`, `arch`, `machine_kind`,
(see [Machine info](#machine-info)), the collector's own version, and one entry per
configured agent: `{ agent, version }`. The **agent version is the real one**, read out of
a transcript the agent already wrote (`2.1.247`, say, from Claude Code's `version` field). Where an
adapter cannot cheaply establish a version at detection time the field is simply **omitted** rather
than filled with a placeholder, so a missing version in the dashboard means "not reported", never
"not detected".

Claude Code and Codex both report a real version. Claude Code reads it from a transcript
(e.g. `2.1.247`); Codex reads `session_meta.cli_version` from its newest rollout
(e.g. `0.149.0-alpha.4.3`). The same value is attached to every event as `agent_version`.

If your local privacy mode is stricter than the org's, login says so and keeps yours:

```
  Privacy:   metadata (your local setting; org allows analytics)
```

### `start` / `stop`

`agentstrack start` writes a **launchd** agent on macOS (`~/Library/LaunchAgents/ai.agentstrack.collector.plist`)
or a **systemd user unit** on Linux (`~/.config/systemd/user/agentstrack.service`), loads it, and
returns. Neither needs root. The unit restarts the collector only on a **crash**, not after a clean
exit — after `logout` the collector exits cleanly and the supervisor leaves it stopped instead of
respawning it every few seconds (launchd `KeepAlive`/`SuccessfulExit`, systemd `Restart=on-failure`
with a 5-in-5-minutes start limit). `-f` / `--foreground` runs in the terminal instead — best for a
first run. Both write the pidfile, so `status` reports `Running: yes` for either.

`--agent <id>` (repeatable, or comma-separated: `--agent claude_code,codex`) runs only those agents
for this foreground run, overriding `tracking.agents`. It is refused without `--foreground`, because
the service starts without flags and would not see it; an unknown id is refused too. Both exit 2.

`agentstrack stop` removes the service unit *and* signals a foreground collector, and says
`Collector was not running.` when there was neither. There is no "stop but keep the unit"; use
`agentstrack service install` to put it back.

### `summary`

```
agentstrack summary [--days N] [--json]
```

Your own totals from AgentsTrack — sessions, output tokens and cost — for widgets and scripts;
`--json` prints the server's full answer, including the cost basis and per-agent and per-day rows. The API key stays inside the collector; the caller sees only the
totals. `--days` must be a whole number from 1 to 30 (default 7); anything else exits 2. Not logged
in exits 1 (`{"error":"not_logged_in"}` with `--json`); a server without
`GET /v1/collector/summary` exits 2 (`{"error":"unsupported_server"}`).

### `doctor`

```console
$ agentstrack doctor
Configuration
  ✓ config exists at /Users/you/.agentstrack/config.yaml
  ✓ API key present
  ✓ device registered

Agents
  ✓ claude_code sessions found
    225 file(s) modified in the last 7 days   # window is tracking.max_age_days (default 7)
  ✓ codex sessions found
    3 file(s) modified in the last 7 days
  - opencode not installed
  - antigravity not installed
  - gemini_cli not installed

Connectivity
  ✗ API reachable at https://api.agentstrack.ai
    fetch failed

Queue
  ✓ queue depth 0
    log: /Users/you/.agentstrack/collector.log

1 problem(s) found.
```

Exit code is non-zero when there is a problem, so it works in a monitoring check. An agent that is
not installed is listed, not counted as a problem; having none of `tracking.agents` installed is.
`agentstrack doctor --json` prints the structured form, which is what the bug template asks for:

```json
{
  "version": "0.7.0",
  "node": "v24.11.0",
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
auto_update: true
privacy:
  mode: analytics
  prompts: local_summary_only
  code_content: never
  file_paths: relative
  shell_arguments: redact_secrets
  excluded_projects: []
tracking:
  max_age_days: 7
  idle_timeout_seconds: 120
  git_metadata: true
  process_metrics: true
  open_island_rate_limits: false
  agents:
    - claude_code
    - codex
    - opencode
    - antigravity
    - gemini_cli
    # - kimi_code      # opt-in: adapter not yet verified against real sessions
upload:
  batch_size: 100
  interval_seconds: 30
  max_retries: 8
  concurrency: 4
```

There is no `config set` — edit the YAML. An invalid config is a **hard error**, never a silent
fallback to defaults, so a typo cannot quietly widen your privacy mode; the error lists each bad key
as `path: message`. An **unknown** key is accepted, so a config written by a newer collector still
loads, but it prints `unknown config key '…' is ignored` — a misspelt `privacy.excluded_project`
is no longer silent.

### `sync`

Scans once, drains the spool and exits — useful after a network outage, or on a machine where you
would rather not run a daemon. When a collector is already running (`status` shows `Running: yes`),
`sync` skips the scan, says the running collector reads new lines itself, and only uploads what is
queued: two readers of the same files would each resume from their own checkpoints. It does **not**
take a time window.

```console
$ agentstrack sync
✓ Queue is already empty.

$ agentstrack sync --dry-run
✓ Nothing queued and nothing new in transcripts — nothing would be sent.
```

With a backlog it prints `Uploading <n> queued events…` and then either `✓ Uploaded <n> events.` or,
if some remain, a warning naming the log — and exits non-zero, so it is safe to run from cron. If the
server rejects the API key it says so and exits 1.

`--full` clears the read checkpoints, re-reads every transcript inside `tracking.max_age_days` and
uploads the result; events the server already holds come back as duplicates and are not stored
twice. It fetches the org policy before scanning.

`--dry-run` uploads nothing and prints a breakdown by event type; `--print` adds the full
post-redaction JSON body of each one — see [Verify it yourself](#verify-it-yourself). It copies the
spool to a temporary directory, runs one scan against the copy (fetching the org policy first) and
lists **every** event in it: what is already queued plus what the next scan would add. The real
spool, its queue and its read checkpoints are not touched, and the copy is deleted afterwards —
on Ctrl-C too.
`--full` is ignored with `--dry-run`, with a notice.

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
auto_update: true                        # install newer releases of this package by itself (global npm installs only)

# --- Privacy ------------------------------------------------------------
privacy:
  # metadata  | analytics (default) | full     — see the table above
  mode: analytics

  # never | local_summary_only (default) | full
  # `full` is what keeps `mode: full` from uploading prompt text unless you also
  # ask for it here. `never` suppresses prompt text in every mode, and it
  # additionally drops the locally derived `derived_title` in every mode too —
  # `analytics` and `full` alike — so nothing derived from a prompt leaves the
  # machine at all. See the privacy section.
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
  # `never` sends only the binary name (leading VAR=value and sudo/env/nohup/
  # time wrappers skipped). The other two keep the whole command line; secret
  # redaction is applied either way, so `full` behaves like `redact_secrets`.
  # `metadata` mode sends the binary name only, whatever this says.
  shell_arguments: redact_secrets

  # Prefix match on whole path segments of the session's working directory.
  # `~` expands. An excluded project produces no events of any kind, and while
  # this list is non-empty an event with no known project is dropped too.
  excluded_projects: []

# --- Tracking -----------------------------------------------------------
tracking:
  # How far back to look for transcript files, by modification time. 1–3650.
  # Raise it once to import older history, then put it back.
  max_age_days: 7

  # A session quiet this long gets a `session.ended` (reason: timeout). 30–3600.
  idle_timeout_seconds: 120

  # Read git branch, project root and a HASH of the remote; poll `git log` for
  # commits made during a session; emit git.branch_changed. `false` means no git
  # process is ever spawned.
  git_metadata: true

  # Deprecated: accepted for old configs and has no effect. `false` prints a warning.
  process_metrics: true

  # Read Claude Code's 5h/7d plan windows from Open Island's
  # /tmp/open-island-rl.json. Off by default; refused if the file is a symlink,
  # not owned by you or over 4 KB. Read only — nothing is written.
  open_island_rate_limits: false

  # Which adapters to run. Removing one stops it being read entirely.
  # kimi_code is opt-in. `start --foreground --agent <id>` overrides this for one run.
  agents:
    - claude_code
    - codex
    - opencode
    - antigravity
    - gemini_cli

# --- Upload -------------------------------------------------------------
upload:
  batch_size: 100        # events per request. 1–500 (server caps at 500).
  interval_seconds: 30   # seconds between flushes. 5–600.
  max_retries: 8         # non-retryable failures before an event is DELETED. 0–20;
                         # 0 is clamped to 1, since "zero attempts allowed" would
                         # match every queued event on the first failure.
  concurrency: 4         # batches uploaded at once. 1–8.
```

Environment overrides: `AGENTSTRACK_HOME` (all local state), `CLAUDE_CONFIG_DIR` (default
`~/.claude`; `~/.claude-*` profiles and any directory a running Claude Code was launched with are
found on their own), `CODEX_HOME` (default `~/.codex`), `OPENCODE_DATA_DIR` (default
`$XDG_DATA_HOME/opencode`, falling back to `~/.local/share/opencode`) and `OPENCODE_DB` (the
database filename or an absolute path — the same override OpenCode itself honours),
`GEMINI_CLI_HOME` (Gemini CLI reads `$GEMINI_CLI_HOME/.gemini`, default `~/.gemini`) and
`KIMI_SHARE_DIR` (default `~/.kimi`).

---

## Supported agents

| Agent | Status | Reads |
|---|---|---|
| **Claude Code** | ✅ Stable | `~/.claude/projects/<slug>/<session-uuid>.jsonl`, plus `<session-uuid>/subagents/**/agent-<id>.jsonl` |
| **Codex** | ✅ Stable | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` |
| **OpenCode** | ✅ Stable | `~/.local/share/opencode/opencode.db` — SQLite, opened **read-only** |
| **Antigravity CLI** (`agy`) | 🧪 New | `~/.gemini/antigravity-cli/conversations/<id>.db` — one SQLite db per conversation, read from a private **copy** |
| **Gemini CLI** | 🧪 New | `~/.gemini/tmp/<project>/chats/session-*.jsonl` |
| **Kimi Code** (`kimi-cli`) | ⚠️ Experimental, opt-in | `~/.kimi/sessions/<md5(work dir)>/<session>/wire.jsonl` — written from upstream source, not yet verified against real sessions |
| Cursor · Cline · Copilot CLI | 🗓 Planned | ids reserved in the schema, no adapter yet |

Per-signal honesty — the adapters do not produce identical data, because the agents do not record
identical things:

| Signal | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Session start | ➖ inferred from the first event | ✅ from `session_meta` | ✅ from the `session` row |
| Session end | ➖ inferred | ➖ inferred | ✅ on archive or compaction |
| Prompts / titles | ✅ | ✅ | ✅ (OpenCode names its own sessions) |
| Per-response token usage | ✅ `model.response` with full cache breakdown | ✅ per `token_usage_record` where the rollout writes them; ➖ cumulative snapshots on older rollouts | ➖ cumulative per-session totals only |
| **Provider-reported cost** | ➖ estimated from a rate card | ➖ estimated | ✅ **`REPORTED` — the real settled charge** |
| Turn boundaries | ➖ not logged | ✅ `agent.turn.started` / `.ended` | ➖ not emitted |
| Tool calls | ✅ | ✅ (incl. `custom_tool_call`) | ✅ terminal event with a real duration |
| Commands | ✅ from `Bash` tool input | ✅ with exit code and duration | ✅ from the `bash` tool's input |
| File changes + line counts | ✅ from `Edit`/`MultiEdit`/`Write`/`NotebookEdit` inputs | ✅ parsed from the `apply_patch` body | ✅ from `edit`/`write` tool inputs |
| File reads | ✅ from the `Read` tool | ➖ heuristic, from `cat`/`head`/`tail`/`sed`/`nl`/`bat`/`less` | ✅ from the `read` tool |
| Agent errors | ➖ not logged | ✅ `error` | ➖ not emitted |
| Commits | ✅ (from `git log`, not the transcript) | ✅ (same) | ✅ (same) |
| Plan / subscription type | ➖ | ✅ `plan_type` | ➖ |
| Account attribution | ✅ per session, from the login of the config dir its process runs under | ✅ ChatGPT `account_id` from `auth.json` | ✅ from `account.json`, per provider |
| Skills / sub-agents / workflows | ✅ `Skill`, `Agent`, `Workflow` tool calls named; sub-agent transcripts stamped `sidechain` | ➖ Codex's `spawn_agent` collaboration tools are defined in its prompt but no rollout on hand shows one invoked, so nothing is parsed yet | ➖ `parent_session_id` only |

The newer adapters, briefly:

- **Antigravity** — per model call `model.response` with input, cache-read, cache-write, output and
  thinking tokens (from the step's `ModelUsageStats`); prompts; tool calls with real durations;
  `run_command` commands; `view_file` reads; `write_to_file` / `replace_file_content` line counts.
  Workspace and git branch come from the conversation's metadata — headless `agy -p` runs record no
  workspace and are sent with no project. Account: the email in agy's own sign-in log line (agy
  keeps its token in the keychain and writes no account file).
- **Gemini CLI** — per response `model.response` (Gemini's `promptTokenCount` includes cached
  tokens and `candidatesTokenCount` excludes thoughts; both are normalized), prompts (not the
  injected `<session_context>` block or slash commands), terminal tool calls, shell commands and
  `read_file` / `write_file` / `replace` effects. No tool durations — the log has one timestamp per
  call. Account: `google_accounts.json`'s active email.
- **Kimi Code** — per-step token usage, prompts, turns, tool calls paired with results for a
  duration, `Shell` / `ReadFile` / `WriteFile` / `StrReplaceFile` effects, and sub-agent work relayed
  through the parent session. The wire log never names the model, so the one in `config.toml`'s
  `default_model` is used. No account.

Google accounts expose no stable id on disk, only an email, so their `account.key` is a hash of it
and the email travels only as the strippable label.

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
(Claude Code's `accountUuid`; OpenCode's `<serviceID>:<accountId>`; Codex's ChatGPT `account_id`;
a hash of the Google email for Gemini CLI and Antigravity) so their costs never merge. The
readable half — email, organization name — is PII and is stripped in `metadata` mode, where sessions
still split correctly but the account shows as opaque.

**The credential is never read.** OpenCode's `account.json` stores a live API key next to the account
id; only `id` and `serviceID` are touched, and OpenCode's `auth.json` is never opened at all. Codex's
`auth.json` is mostly tokens: only `tokens.account_id` and the decoded (unverified) payload of the
`id_token` — email and plan — are used, and no token leaves the function that reads it.

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
| `GET` | `/v1/collector/config` | Daemon start, then every 10 minutes (every minute until it first succeeds); `sync` when it scans, `sync --full`, `sync --dry-run` and `doctor` — org privacy ceiling, redaction rules, accepted event types. Not called by `login`: the register response already carries the ceiling |
| `POST` | `/v1/collector/health` | Every 60s while running — queue depth, version, detected agents |
| `POST` | `/v1/events/batch` | Every `upload.interval_seconds`, or when the queue reaches `batch_size`; `sync` |
| `GET` | `/v1/collector/summary` | `agentstrack summary` only |

Auto-update (`auto_update: true`) also asks `https://registry.npmjs.org` for this package's latest
version every six hours, and installs it from there.

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
5. Is anything queued but stuck, or is a session being filtered out? `agentstrack sync --dry-run`
   shows everything queued plus what the next scan would add.
6. Does the log say `No org policy yet`? A registered device collects nothing until it has reached
   `GET /v1/collector/config` once — check connectivity with `agentstrack doctor`.
7. Is `excluded_projects` set? Then events with no known working directory are dropped, and the log
   says how many.

### The queue is not draining

`agentstrack status` shows `Queue depth` climbing. Check `agentstrack doctor`, then the log:

| Symptom | Cause | Fix |
|---|---|---|
| `Uploads paused (auth)` — `401` | Key revoked or wrong | `agentstrack login <new-key>`; nothing was dropped |
| `Uploads paused (auth)` — `403` | Key lacks ingest permission | Issue a new key; nothing was dropped |
| `Uploads paused (quota)` | Org over its monthly event cap | Events stay spooled and resume when the cap resets or the plan changes |
| `Uploads paused (schema)` | Server rejects every event — collector older than the API | Upgrade the collector; nothing was dropped |
| `fetch failed`, `ETIMEDOUT`, `request timed out after Ns` | Network, VPN or proxy | Set `HTTPS_PROXY`; events keep spooling meanwhile |
| `Server rejected the batch as too large` | Batch above the server's limit | Automatic — batch size halves and recovers |
| `Server rejected the batch as invalid` | A `400`/`422` on a multi-event batch | Automatic — the batch is halved until the bad event is alone; only it is struck |
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

The log records counts, queue depths, status codes and `event_id`s — never payloads, prompts, code,
keys or a server's error body (at most its short `error` code). That is what makes it safe to attach
to an issue. Run with `--verbose` for per-scan event counts and per-batch status codes. It rotates once at 5 MB to `collector.log.1`; a scan pass
writes one `Queued N events across M files` line, not one per file. Please attach `agentstrack doctor --json` too.

### Complete reset

```bash
agentstrack stop
rm -rf ~/.agentstrack          # config, spool, log, pidfile — all local state
agentstrack login <api-key>
agentstrack start
```

---

## Roadmap

Honest list of things that are **not** in 0.7.0, so you do not go looking for them.
[ROADMAP.md](./ROADMAP.md) has the same list with the design constraints and what "help wanted"
means for each.

- **`config get` / `config set` / `config edit`** — edit the YAML by hand for now.
- **Per-run backfill window** (`sync --since 30d`). The window is `tracking.max_age_days` (default 7)
  for every run.
- **Local time accounting.** Human-active / agent-active / idle windows are derived server-side from the event stream; the collector uses `tracking.idle_timeout_seconds` only to decide when a quiet session has ended.
- **Process metrics.** `tracking.process_metrics` is deprecated and has no effect.
- **`heartbeat` and `model.request`** are in the schema but nothing emits them. `session.ended` is not read from any Claude Code or Codex transcript — the daemon emits it after `tracking.idle_timeout_seconds` of quiet (`reason: timeout`).
- **`shell_arguments: full`** behaves exactly like `redact_secrets`: commands are always secret-redacted.
- **Local task classification** (`task_category`) — the field exists in the schema; the collector only derives a title.
- **Windows.** The service installer covers launchd and systemd only; `--foreground` works anywhere Node 24+ does.

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
