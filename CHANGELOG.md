# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A change to the event envelope or to the config file shape is a **breaking change** and will be
released as a major version, with a migration note in this file.

## [Unreleased]

## [0.7.0] - 2026-11-28

Behaviour changes worth reading before you update: a registered device reads and uploads nothing
until it has fetched its org privacy policy at least once; that policy is re-fetched while the
collector runs and remembered across an offline restart; with `privacy.excluded_projects` set,
events whose project cannot be determined are dropped; plain `sync` scans transcripts when no
collector is running, and `sync --dry-run` scans too instead of only showing the queue; `status`
exits 0 when the device is not configured.

### Added

- **Plan headroom: `rate_limit.reported`.** Codex's `rate_limits` windows (used %, window length,
  reset time) are reported when they change, keyed by window length. The `credits` balance is never
  read. Additive: a new event type, sent only to a server that lists it in the `event_types` field of
  `GET /v1/collector/config`, so an older backend is never handed an event it would reject.
- `tracking.open_island_rate_limits` (default `false`): read Claude Code's 5h/7d windows from Open
  Island's `/tmp/open-island-rl.json` and report them on the most recently active Claude session.
  The file is refused if it is a symlink, not owned by you or over 4 KB, and its figures are labelled
  advisory. Read only; nothing is written.
- **`git.branch_changed` is emitted.** When a repository's branch differs from the last branch this
  collector process read for it, a `git.branch_changed` event with `{ from, to }` (and the usual
  `repo` context) is queued right after the event that revealed it. The first read of a repository
  after a start is never a change, so a restart does not look like a checkout. Requires
  `tracking.git_metadata` (the default) and an adapter that reports a working directory. Branch
  names are secret-redacted like every other label.
- **`MultiEdit` produces `file.changed`.** One event per call, with `lines_added` / `lines_removed`
  summed over its edits. `NotebookEdit` now reads `notebook_path`, so its edits are reported too, and
  a cell delete counts its lines as removed.
- **`--verbose`** (global): writes event counts per scan, batch sizes and server status codes to the
  log and to stderr, prefixed `[verbose]`. Never payloads, prompts, paths or keys.
- **`start --foreground --agent <id>`**: run only the named agents for this run, overriding
  `tracking.agents`. Repeatable or comma-separated. An unknown id, or `--agent` without
  `--foreground`, exits 2 — the service runs without flags, so the override could not reach it.
- Config warnings: an unknown key (`privacy.excluded_project`, say) is still accepted, so a config
  from a newer collector loads, but it now prints `unknown config key '…' is ignored`.
  `tracking.process_metrics: false` warns that the key has no effect.

### Changed

- **No collection until the org policy is known.** Privacy is applied when an event is queued, so an
  event spooled under the local mode before the org's ceiling arrived would later be uploaded at the
  looser mode. A registered device with no org policy in force — never fetched, and none stored from
  an earlier fetch — now neither reads transcripts nor uploads until `GET /v1/collector/config`
  succeeds once. Read offsets do not advance meanwhile, so nothing is lost: the first scan after the
  fetch picks everything up. The log says `No org policy yet … not reading or uploading until it is`
  once.
- **The org privacy policy is refreshed while the collector runs, and survives a restart offline.**
  `GET /v1/collector/config` was read once per daemon start; it is now re-fetched every 10 minutes,
  and every minute until the first fetch succeeds. The last policy fetched (mode ceiling and
  redaction rules) is stored in the spool as the `org_policy` meta key, so a collector that starts
  with no network still clamps to it instead of to the local file alone. A stored policy that cannot
  be parsed is ignored, which means holding collection as above. `sync`, `sync --full` and
  `sync --dry-run` fetch the policy before scanning.
- **An org privacy mode this collector does not recognise is treated as `metadata`** — in the
  register response, the config response and the stored policy. Previously an unknown value could be
  written into `config.yaml` as-is. The config response is now validated; an unreadable one is an
  error and is retried. A single malformed org redaction rule is dropped on its own rather than
  making the whole response unreadable.
- **With `privacy.excluded_projects` set, events whose project is unknown are dropped.** An event,
  from a transcript or from a database-backed adapter (OpenCode, Antigravity), that carries neither a
  working directory nor a repository path cannot be shown not to belong to an excluded project, so it
  is not sent; the count is logged. Exclusion also now
  matches on the adapter's repository path when there is no working directory. Nothing changes when
  the list is empty.
- **Plain `sync` scans before uploading when no collector is running**, so it sends what
  `sync --dry-run` showed; on a fresh install the queue is empty until something has read the
  transcripts. When a collector is running (its pidfile is live), `sync` only uploads what is queued
  and says the running collector reads new lines itself — two readers of the same files would each
  resume from their own checkpoints.
- **`sync --dry-run` scans transcripts.** It used to list only the head of the queue, up to
  `upload.batch_size` events, so new transcript lines and anything past the first batch were not
  shown. It now copies the spool to a temporary directory, runs one scan against the copy, and lists
  every event that copy holds: what is queued plus what the next scan would add. No event is
  uploaded, no read checkpoint or queue row is written to the real spool, and the copy is deleted
  afterwards, including on Ctrl-C. It does contact the server for the org policy, and writes no scan
  counts to the log. `--full` with `--dry-run` is still ignored, with a notice.
- **`status` and `status --json` exit 0 when the device is not configured.** `configured` and
  `logged_in` (or the `Not configured` line) carry that state. `status --json` used to exit 1.
- `summary --days` must be a whole number from 1 to 30; anything else exits 2 instead of being
  silently clamped.
- `doctor` lists agents that are not installed as `- <agent> not installed` instead of counting
  each one as a problem. It still reports a problem when none of `tracking.agents` is installed.
- An invalid config file now lists each problem as `path: message`, one per line.
- `stop` says `Collector was not running.` when there was neither a service nor a foreground
  collector, instead of claiming to have stopped one.
- `sync` exits 1 with a clear message when the server rejects the API key.

### Fixed

- **No spurious `session.ended` on stop or restart.** Stopping the daemon, an auto-update restart and
  the end of `sync --full` emitted `session.ended` (`reason: unknown`) for every open session,
  cutting it short. Sessions now end only on the idle timeout. The idle check is also skipped while a
  backfill is still reading a file, so a session is not ended at the point the read has reached.
- **Codex: live token usage is no longer counted twice.** A live rollout could be gauged from its
  `token_count` totals before its first `token_usage_record` appeared, and then billed per record as
  well. A file is now billed per record from the first record seen, with no version cutoff.
- **Codex: the working directory is recovered when a file is resumed mid-way**, from the first
  line's `session_meta`, so `excluded_projects` and repository context apply before the next
  `turn_context`.
- **A 400 or 422 on a multi-event batch no longer strikes every event in it.** The batch is halved
  and retried, as a `413` already was, until the bad event is alone and only it is struck.
- A stale `Uploads: paused` recorded by an earlier process is cleared on the next upload pass that
  is not itself paused, so `status` stops reporting a pause that no longer applies.
- `status` and `doctor` no longer create `spool.db` when it does not exist.
- A request that hits the client timeout reports `request timed out after Ns` instead of
  `This operation was aborted`.

### Security

- **Labels are secret-redacted in every mode, `metadata` included.** `workflow_name`, `skill`,
  `subagent_type`, `agent_type`, `agent_kind`, `agent_id`, `tool_name`, `abort_reason`,
  `stop_reason`, `error_kind`, `model`, `plan_type`, `branch`, `project_name`, `repo.branch`,
  `repo.project_name` and `git.branch_changed`'s `from` / `to` come from transcripts or the
  repository and were sent unscanned. A match is counted in `secrets_redacted` like any other.
- **More built-in secret patterns:** `npm_…`, `glpat-…`, `hf_…`, SendGrid `SG.….…`, Google OAuth
  `ya29.…`, `Authorization: Basic …`, `Authorization: Token …`, `Cookie:` / `Set-Cookie:` headers,
  `--token` / `--api-key` / `--secret` / `--access-token`-style flags, `curl -u user:pass`, and
  `key=value`, `key: value`, query-string and JSON (including backslash-escaped JSON inside a shell
  string) assignments in any case where the key ends in `secret`, `token`, `password`, `pwd`,
  `api_key`, `access_key`, `private_key` or `secret_key`. `pass` and `auth` count as keys only with
  `=` or as a quoted JSON key. Prefixed tokens (`AKIA`, `AIza`, `npm_`, `hf_`, JWTs, …) are now
  found inside identifiers such as MCP tool names, where `_` used to hide them.
- **`metadata` mode's binary name is the real command.** Leading `NAME=value` assignments and the
  `sudo`, `env`, `command`, `nohup` and `time` wrappers (and their flags) are skipped, and the
  basename is sent: `API_TOKEN=abc npm test` used to send `API_TOKEN=abc` as the "binary". The same
  applies under `shell_arguments: never`.
- **`error.message` and `abort_reason` are truncated after redaction** (1000 and 50 characters),
  not before, so a cut cannot split a secret into fragments no pattern matches.
- **Path prefixes are segment-bounded.** A file under `/u/app-secret` is no longer treated as inside
  project `/u/app` (which sent it as `-secret/…`), and the same holds for the home directory.
- `basic_auth_url` (`scheme://user:pass@host`) is matched in linear time on long inputs.
- **Org redaction rules are checked harder.** A rule with more than one unbounded quantifier
  (`*`, `+`, `{n,}`, `{n,m}` with m ≥ 100) is rejected in addition to the nested-quantifier,
  backreference and length checks. A skipped rule is logged by index and reason, never its pattern.
- **Server error bodies are never logged.** A failed request logs its status and, at most, the
  server's `error` code, redacted and capped at 120 characters; a 4xx can echo back what was sent.
- **Self-update installs only a plain `x.y.z` version** from the registry's answer, pins
  `https://registry.npmjs.org` for the package and its scope on the command line, and runs npm from
  the OS temp directory, so neither a user `.npmrc` registry setting nor the `.npmrc` of whatever
  project the collector was started in can redirect an unattended install.
- **systemd unit values are escaped.** `%` is doubled everywhere and `$` in `ExecStart=`; a path
  containing a newline is refused rather than written into the unit.
- **git runs with the repository's own hooks and drivers disabled:** `core.fsmonitor=false`, a
  `cat` pager, `--no-ext-diff`, `--no-textconv`, no system config and no terminal prompts. The
  repository comes from a transcript, so its config must not get to run a program.

## [0.6.2] - 2026-11-26

### Fixed

- Events that carry `duration_ms` are now stamped at the **start** of the work, which is what the
  server's time reconstruction assumes. Codex command results (`exec_command_end`,
  `CommandExecution` items), Codex MCP calls and Kimi Code tool results were stamped when they
  ended, so a ten-minute command counted up to ten more minutes of agent time after it finished.
  They are now back-dated to `end − duration_ms`, never before the call itself. Event ids are
  unchanged, so a re-read line still deduplicates.
- Codex `agent.turn.ended` no longer carries `duration_ms`: it is the end-of-turn marker and stays
  stamped at the end, so the duration was being counted after the turn as well.
- `project_name` is trimmed, cut to 100 characters, and omitted when it contains a link. It becomes
  the project's name on the server, which mails it in summaries and alerts.

## [0.6.1] — 2026-11-02

### Added

- Codex MCP tool calls (`McpToolCall` items, which have no tool-call line of their own) are reported
  as `mcp__<server>__<tool>` tool events with their duration.
- Codex turns carry `duration_ms`, and an interrupted turn ends with `aborted: true` and Codex's
  reason (`turn_aborted`).
- A forked or multi-agent Codex thread's `session.started` carries `parent_session_id`.

### Fixed

- **Privacy (B1): excluded projects no longer leak commits.** A `git.commit` event (repository root,
  commit SHA, diffstat) was uploaded for commits made in a project listed under
  `privacy.excluded_projects`. Two paths did this: a session whose working directory was excluded
  still armed its repository for commit reporting, and in a monorepo an excluded subfolder shared
  its root with an allowed project, so commits touching that subfolder were reported. Both are fixed:
  excluded working directories are ignored, and any commit touching an excluded path is dropped. A
  commit whose changed files cannot be listed is also dropped, so the check fails closed. Commits
  whose files are all outside the exclusion list are reported as before. If you exclude a project,
  update to this release; commits already uploaded are not recalled by this change.

- **Codex 0.15x and newer: prompts, commands and file edits are collected again.** These builds
  stopped writing `user_message` and `exec_command_end`. Prompts, commands and edits now come from
  the `item_completed` items (`UserMessage`, `CommandExecution`, `FileChange`), so these sessions no
  longer show zero prompts. Edit line counts are computed locally; file bodies never enter an event.
- **Codex token accounting is per response.** Newer rollouts write a `token_usage_record` per model
  response. Each one is billed once (deduplicated on `response_id`) under the model that served it,
  instead of the session-wide running total. This fixes two double counts: a mid-session model switch
  counting the whole total under both models, and a forked or multi-agent child thread re-billing the
  parent history it starts from. Older rollouts keep the running-total gauge. Sessions already
  ingested are not rewritten.

### Security

- `zod` 4.4.3 → 4.6.7 (lockfile only, within the existing `^4.4.3` range): fixes
  [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), memory exhaustion while
  validating oversized constrained collections. `zod` validates the config file and server
  responses, so this is a runtime dependency. Dev-only: `source-map-js` 1.2.1 → 1.2.2
  ([GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)).

## [0.6.0] — 2026-10-31

### Added

- `agentstrack summary [--days N] [--json]`: your own recent totals from AgentsTrack (sessions,
  tokens, cost with its basis, per-agent and per-day), for widgets and scripts. The API key stays
  inside the collector; callers only see the totals. Needs a server with `GET /v1/collector/summary`;
  an older server answers `{"error":"unsupported_server"}` with exit code 2.
- `status --json` now includes `upload_paused_reason` (null when uploads are running).

### Changed

- **Requires Node 24 or newer** (`engines.node >= 24`, was `>= 22`). Node 22 is no longer tested or
  supported; upgrade Node before updating the collector. Development, the release job and CodeQL run
  on Node 26; CI tests 24 and 26.

## [0.5.0] — 2026-09-29

### Added

- **Antigravity CLI adapter** (`antigravity`, new agent id). Reads agy's per-conversation SQLite
  databases under `~/.gemini/antigravity-cli/conversations/`, decoding the protobuf step blobs with
  field numbers taken from the descriptors in the agy 1.2.13 binary: prompts, per-call token usage
  (input, cache read/write, output, thinking), tool calls with durations, commands, file reads and
  line-counted edits, workspace and branch. A changed conversation is copied to a private temp dir
  and read there, so the live database is never opened. Account from agy's sign-in log line.
- **Gemini CLI adapter** (`gemini_cli`). Tails `~/.gemini/tmp/<project>/chats/session-*.jsonl`
  (0.61 format): prompts, per-response tokens, terminal tool calls, commands and file effects.
  Re-appended and `$set`-rewritten messages are keyed on their ids, so nothing is billed twice.
- **Kimi Code adapter** (`kimi_code`, new agent id), **opt-in and experimental**: written from the
  kimi-cli 1.52 source, not yet verified against real sessions. Add `kimi_code` to
  `tracking.agents` to enable it.
- **Codex sessions carry an account.** `~/.codex/auth.json`'s `tokens.account_id` is the key; email
  and plan come from the id_token's decoded payload. No token is kept or sent.

### Changed

- `tracking.agents` defaults to `[claude_code, codex, opencode, antigravity, gemini_cli]` for new
  installs. `login` writes the full config, so an existing `config.yaml` keeps the list it has —
  add `antigravity` / `gemini_cli` there to enable them.
- The event envelope's `agent` enum gains `antigravity` and `kimi_code`; the server must accept them
  before a collector that sends them.

### Fixed

- **A symlink loop no longer multiplies the transcript walk.** A `~/.claude/projects/projects -> .`
  link made every transcript be found under up to five aliases; directories are now walked once by
  their real path.

## [0.4.6] — 2026-09-25

### Fixed

- **Claude Code sessions are attributed to the account that actually ran them.** Several logins
  running side by side (one `CLAUDE_CONFIG_DIR` per profile, sharing one `projects/` folder) were
  all attributed to whichever account `~/.claude.json` held. Each live session is now pinned to the
  login of the config directory its process was launched with, read from
  `<config>/sessions/<pid>.json` and the process environment. A profile's login is read from
  inside its own directory, `~/.claude-*` profiles are discovered automatically, and a shared
  transcript folder gives an unseen session no account rather than a guessed one.

## [0.4.5] — 2026-09-24

### Fixed

- **Auto-update works under launchd.** The service starts with
  `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, where an nvm or Homebrew `npm` does not exist,
  so every update attempt on such a Mac failed to install — and, since each version is
  attempted once, never retried. npm now runs with the running node's own directory
  first on `PATH`. Machines on 0.4.3 or 0.4.4 still carry the old updater and need this
  one upgrade by hand: `npm i -g @agentstrack/collector@latest`, then
  `launchctl kickstart -k gui/$(id -u)/ai.agentstrack.collector`.

## [0.4.4] — 2026-09-24

### Fixed

- **A commit is uploaded once, however often the collector restarts.** The commit
  watcher remembers what it has sent in memory only, so a restart inside a session's
  window sent the same commit again under a fresh random id, and the server stored
  both. A `git.commit` event's id is now derived from the session and the commit sha,
  so a repeat is dropped as a duplicate. It was the last event given a random id.
- **`find -path`, `tar -p` and `ssh -p2222` no longer raise a leaked-password alert.**
  The short `-pSECRET` form matched on any command, so flags an agent runs dozens of
  times an hour became rotation alerts with no credential behind them. The short form
  now matches only on commands that read `-p` as a password; `--password=X` and
  `*_PASSWORD=` still match anywhere.

## [0.4.3] — 2026-09-18

### Added

- **`sync --full` re-reads everything and re-sends whatever the server is missing.**
  Plain `sync` only drains the queue, so anything the spool already considered sent
  stayed on disk no matter what the server actually held. `--full` forgets the read
  checkpoints and re-reads every transcript from byte 0.

  Re-reading is safe rather than merely tolerable: an `event_id` is derived from
  `(adapter, file, offset, line)` and is the server's primary key, so the same line
  always produces the same id and the server stores it once. What comes back as
  `duplicates` is the proof it already had it. Nothing is written twice, and the
  queued events are left alone — dropping those would turn a reconcile into data loss
  in the one case it exists to repair.

- **Reconciliation happens on its own when the backend changes.** Pointing a collector
  at a different deployment — `login` against another instance — used to upload only
  what happened *after* the switch, while every earlier session sat on disk looking
  uploaded. Silent, and invisible until someone counted rows. The daemon now notices
  that the `api_url` + `collector_id` pair is one this spool has not uploaded to,
  clears the checkpoints once, and lets the next scan refill the gap. A fresh install
  is exempt: checkpoints cannot be stale against a backend nothing was ever sent to.

- **Auto-update (`auto_update`, default `true`).** The collector runs unattended under
  a supervisor, so a fix otherwise waits for someone to run npm by hand on every
  machine. It checks the registry every six hours and installs a newer release itself.

  Bounded deliberately: it installs only this package, by exact version, from the
  public registry, and only when the running copy is a global npm install — a source
  checkout is never touched, because `npm i -g` over a working tree would replace what
  its author is editing. The restart is an exit, not an exec: both supervisors restart
  on failure, so it exits `70` and lets them start the new code. And it attempts a
  given version once, remembered across restarts, so a release that installs but
  cannot run costs one restart and a log line instead of burning systemd's
  `StartLimitBurst` and taking the service down for good.

  Set `auto_update: false` where a fleet pins versions centrally.

## [0.4.2] — 2026-09-18

### Fixed

- **`login` sent the key to whatever host was configured last.** The endpoint was
  carried forward from the existing config, so pasting a production key on a machine
  still pointed at another instance sent it there and failed with
  `401 {"message":"Invalid API key"}` — accurate about the response, wrong about the
  cause, and the key is the first thing anyone re-checks.

  A login is an environment switch at least as often as a key rotation, and a key
  issued by one deployment means nothing to another. The endpoint now comes from
  `--api-url` or the production default (`https://api.agentstrack.ai`), never from the
  stale value. Self-hosters pass `--api-url`, which is what that flag is for; it still
  persists in the config for the daemon afterwards.

  Switching silently in the other direction would be the same bug pointing elsewhere,
  so a login that moves the endpoint now prints `! Switching endpoint: <old> → <new>`.

  **What to do:** nothing, unless you self-host and script `agentstrack login` without
  `--api-url` — add it, or the next login retargets that machine at the hosted service.

## [0.4.1] — 2026-09-05

### Fixed

- **A session title could ship a piece of a secret (security).** `derived_title` is the first
  meaningful line of your prompt, cut to 120 characters. Until now that cut was made on the **raw**
  prompt and the secret scan ran afterwards, on the already-shortened title. If a key happened to
  straddle the 120-character boundary, the cut split it in two, the leftover head no longer looked
  like a key to any pattern, and it was uploaded as ordinary title text. A prompt of a hundred
  characters followed by an `sk-ant-…` key produced a title ending in `sk-ant-api03-AAAAA…` while
  the event dutifully reported `secrets_redacted: [{ anthropic_key, 1 }]` — the tally was right and
  the title still carried a fragment.

  The prompt is now redacted **before** the title is taken from it, in all three adapters (Claude
  Code, Codex, OpenCode), so a truncation can only ever cut through a `[REDACTED:…]` marker. The
  privacy pipeline still redacts `derived_title` afterwards; that pass is now a no-op and stays in
  place as defence in depth.

  The same cut-then-scan mistake applied to a Codex `error` event's `message`, truncated to 1000
  characters; it is redacted before truncation now too.

  **What to do:** only a partial value could escape, never a whole one, and only when a secret sat
  across the cut. But a fragment is enough to identify which key was pasted, and the rest of it may
  be guessable from context. If you have used `analytics` or `full` mode, look through your existing
  session titles for key-shaped fragments, and rotate anything you find. Titles produced from 0.4.1
  on are safe.

  Fragments already uploaded stay in the product until you delete those sessions — upgrading the
  collector does not rewrite history.

### Changed

- Documented the ordering (redact, then truncate) in the README and `docs/EVENT_SCHEMA.md`, and
  corrected two stale lines there that still said `privacy.prompts: never` leaves `derived_title`
  in place under `mode: full`. It has not since 0.4.0 — `never` drops it in every mode.

## [0.4.0] — 2026-09-05

### Added
- **Secret exposure is reported as metadata.** When local redaction fires, the event now carries
  `secrets_redacted: [{ kind, count }]` — which pattern matched and how many times, sorted by kind
  and omitted entirely when nothing fired. The matched value never travels: not the text, not a
  prefix of it, not a hash, not the surrounding context. The tally is computed **before** the mode
  strip, so it survives `metadata` mode — the mode where a team most wants to know a credential was
  typed into an agent and least wants the credential itself. An org-supplied rule reports as the
  single generic kind `org_rule`, because a rule name can itself describe the shape of that
  organization's secrets.

## [0.3.0] — 2026-09-05

### Added
- **Skills, sub-agents and workflows are named.** A Claude Code `tool_use` named `Skill` carries
  `skill`; `Agent` carries `subagent_type` and `description`; `Workflow` carries `workflow_name`
  (the `name` from the script's `meta` header, when it is that simple). The `Agent` call's prompt and the
  script body are never copied out of the call; a sub-agent transcript's own opening prompt is a
  prompt like any other and follows `privacy.prompts`. The extras ride on `tool.started` and on the matching
  `tool.completed` / `tool.failed`.
- **Sub-agent transcripts are attributed.** Claude Code writes each sub-agent to
  `<session-uuid>/subagents/[workflows/<wf>/]agent-<id>.jsonl` with the parent's session id; the
  tailer already walked them, but nothing said which lines were the sub-agent's. Every event from
  such a file (or any line with `isSidechain: true`) now carries `sidechain: true`, `agent_id`,
  `agent_kind` (`subagent` | `workflow`) and, from the sibling `agent-<id>.meta.json`, `agent_type`
  — so the sub-agent's own `model.response` usage can be attributed to it server-side.
- **`user.prompted.ultracode`**, `true` when the prompt contains the whole word `ultracode`
  (case-insensitive). Computed locally before redaction, so it survives `metadata` mode; the prompt
  does not travel to be inspected.
- **Machine info on register and health.** Alongside `hostname`, `os` and `arch` the collector now
  sends `os_release` and `machine_kind` — `ci` (a CI env var), `container`
  (`/.dockerenv` or a docker/containerd/kubepods cgroup), `workstation` (macOS, Windows, or Linux
  with a display), `server` (headless Linux), else `unknown`. Health repeats it, so a device that
  changes shape is updated. See the README privacy section for what the server does with it.

### Changed
- `description` (the Agent tool's one-line label) is treated like a title: secret-redacted, and
  dropped in `metadata` mode.

### Security
- **`api_url` must be `https`.** The bearer API key rides on every request, so `http` is now rejected
  for any host except `localhost`/`127.0.0.1`/`[::1]`. `login` prints the URL it is about to use.
- **The API key can stay off the command line.** `agentstrack login` now takes the key as an optional
  argument and otherwise reads `AGENTSTRACK_API_KEY`, an echo-off terminal prompt, or stdin
  (`agentstrack login < key.txt`), keeping it out of shell history and `ps`.
- **`config.yaml` is written atomically at mode 600** — a temp file created 0600 then renamed over the
  target, so a crash can no longer leave a truncated config or a brief world-readable window.
- **Org redaction rules are bounded.** A server-supplied pattern that is malformed, over 256
  characters, or using a backreference is skipped (as a malformed rule already was), the common
  catastrophic nested-quantifier shapes (`(a+)+`, `(a|aa)+`, `((a+)b)+`) are rejected, and org rules
  match only the first 64 KB of a value — a pathological pattern is much less likely to hang the
  single-threaded daemon.

### Fixed
- **Claude Code tokens and cost were inflated ~1.8x.** Claude Code writes one `assistant` line per
  content block of a single response, each repeating the same `message.id` and usage; every line
  became a `model.response`. Usage is now emitted once per `message.id`.
- **Claude Code tool outcomes were all named `unknown`.** `tool_result` blocks carry only a
  `tool_use_id`; the name is now resolved from the `tool_use` that started the call.
- **Claude Code prompts pasted with an image (or as text blocks) were never counted**, and slash
  command echoes (`<command-name>`, `<command-message>`, `<local-command-stdout>`,
  `<task-notification>`) were counted as human prompts. Both fixed.
- **Codex sessions went dark after a collector restart.** The session id lived only in memory from
  `session_meta`; it is now seeded from the rollout file name, which carries the same uuid.
- **Codex cached tokens were billed twice.** `cached_input_tokens` is a subset of `input_tokens`
  in Codex; the collector now subtracts it so the two are exclusive, as the schema documents.
- **Codex shell commands landed as `shell` with `duration_ms: 0` and never failed.**
  `exec_command_end` carries an argv list, a `{secs,nanos}` duration and a numeric exit code;
  `function_call_output.output` is a string. Both are read as they really are, and `tool.failed`
  is emitted on a non-zero exit.
- **OpenCode `session.ended` was rejected by the server on every emit** (missing
  `external_session_id`, `reason` outside the enum). It now sends `reason: normal` with the
  archived/compacted distinction in `end_kind`.
- **OpenCode resumed sessions never got a `session.started`.** Sessions are fetched by
  `time_updated` but starts were gated on a `time_created` cursor; a per-session marker in the
  spool's meta store replaces it.
- **`logout` now tears the service down first.** It previously left the launchd/systemd unit
  installed, so the supervisor kept restarting an unauthenticated collector. Both units now restart
  only on a crash (launchd `KeepAlive`/`SuccessfulExit`, systemd `Restart=on-failure` with a
  5-in-5-minutes start limit), and the unauthenticated foreground path exits cleanly so the
  supervisor idles.
- **Service units handle paths with spaces and non-ASCII characters.** The CLI path is resolved with
  `fileURLToPath` instead of a percent-encoded `URL.pathname`, plist strings are XML-escaped, and
  systemd `ExecStart` arguments are quoted. `AGENTSTRACK_HOME` is written into the unit when set.
- **A second foreground `start` refuses to run** when one is already collecting (checked via the pid
  file, created with `wx`), preventing two collectors from racing on one spool.
- **`stop` verifies the pid still belongs to a collector** (via `ps`) before signalling it, so a
  recycled pid in a stale pid file is not killed.
- **`doctor` reports the real scan window.** It now prints `modified in the last N day(s)` using
  `tracking.max_age_days` instead of a hard-coded "7 days".
- **`git.commit` polling stops re-diffing history every tick.** Each repo's `git log --since` now
  starts from its last poll, SHAs are listed before any diffstat so `git show --numstat` runs only for
  commits not yet emitted, and the emitted-SHA guard is pruned by age instead of cleared wholesale, so
  a commit inside the lookback window is never re-emitted.

### Changed
- `detect()` reads only the first 16 KB of the newest transcript (by mtime) for the agent version,
  cached on mtime, instead of the whole file every 5 s. OpenCode keeps one read-only database
  handle with prepared statements rather than opening and closing one per query, and caches the
  version for 60 s.
- The contract test now runs every adapter fixture through the server's own payload schemas when
  the server checkout is present, and fails (rather than skips) when `AGENTSTRACK_SERVER_REPO` is
  set but missing.
- **Node floor is `>=22`** (was `>=24`), matching `.nvmrc` and the runtime the code actually needs;
  CI now tests Node 22 and 24.
- `status` shows an upload-paused reason when one is present.

### Fixed — daemon, queue and transport
- **The upload failure policy ran once per concurrent batch, not once per wave.** With
  `upload.concurrency: 4` a dead API escalated the backoff counter by four per wave (5-minute waits
  after two waves), slept inside the wave so tailing froze for the duration, and a sibling's success
  reset the counter or undid a `413` halving. `sendBatch` now returns a pure outcome and `flush()`
  applies the policy once on the wave: halve once, one backoff step, strikes only for poison
  batches, counter reset only when the whole wave succeeded. Backoff sets a next-upload time instead
  of sleeping, honours `Retry-After` / `Retry-After-ingest` as the minimum, and a daemon tick sends
  at most five waves before scanning again. Covered by `src/queue/flush.test.ts`.
- **`401`/`403` no longer count strikes against telemetry.** They pause uploads (`status` shows the
  reason), as does an over-quota `200` — previously acked and dropped locally with the `quota` block
  ignored — and a `200` that rejects every event as malformed, which now logs a version-mismatch
  error instead of deleting the batch.
- **Checkpoints were written before the events were spooled.** A throw between the two lost those
  lines for good. The tailer now streams in 4 MB chunks and commits each chunk's checkpoint in the
  same transaction as its events; a line over 8 MB is skipped to the next newline and counted, at
  most 64 MB per file is read per scan, short reads are looped, and one unreadable file no longer
  aborts the scan for every file after it.
- **Re-reading a transcript double-counted on the server.** `event_id` was a fresh `randomUUID` per
  spool write; it is now derived from the adapter, file, byte offset and line content (a UUID v8
  shape), so a rotated inode, a purged spool or a second collector on the same files dedupes.
- **`VERSION` was hard-coded `0.1.0`.** It is read from `package.json`; the CLI, register and health
  report the published version, and every request carries `User-Agent: agentstrack-collector/<v>`.
- **A Claude Code response spanning a restart was billed twice.** `model.response` is now keyed on
  `message.id` (the daemon's deterministic id, seeded by the adapter), not on the line, so the
  server's dedupe absorbs the second line's copy after a restart.
- **One rejected event paused every upload as a "schema mismatch".** A single-event batch the
  server rejects is now struck like any other poison event; the pause is reserved for a whole
  batch rejected without a quota reason.
- **A failed commit left the checkpoint cache ahead of disk.** `setCheckpoint()` updated the
  in-memory Map before COMMIT; the cache is now reloaded from the table when a transaction throws.
- **OpenCode cursors and started-markers were written before the events they covered.** They are
  now buffered and committed in the same transaction as the enqueue, so a full disk cannot mark a
  session started that was never spooled.
- **systemd `WorkingDirectory=` was quoted.** Path-typed settings are not unquoted by systemd; the
  unit now writes the bare path (`ExecStart=` keeps its quoting).
- **Claude Code and Codex sessions never ended.** The daemon emits `session.ended`
  (`reason: timeout`) for a session quiet longer than `tracking.idle_timeout_seconds`, stamped at
  the moment the timeout elapsed, and `reason: unknown` for anything still open on shutdown.
- The batch response is validated with zod at the trust boundary; an unreadable body is retried,
  never acked. Rejected `allSettled` outcomes are logged instead of swallowed. Local `batch_size` is
  clamped to the server's `max_batch_events`.

### Changed — daemon, queue and transport
- The spool is `VACUUM`ed at open when the freelist is both over 2048 pages and more than half the
  file (a 206 MB spool holding 78 events was observed), the WAL is capped at 8 MB
  (`journal_size_limit`), statements are prepared once, checkpoints are cached in memory so an
  unchanged file costs no SQL, and WAL/SHM are chmod 600 after they exist.
- `describeRepo` is cached per scan pass; `flush()`, `reportHealth()` and `depth()` are inside the
  loop's try/catch; the log rotates once at 5 MB to `collector.log.1` and a scan pass writes one
  `Queued N events across M files` line instead of one per file.
- Org redaction rules are compiled once per server-config refresh and handed to the privacy
  pipeline pre-compiled, instead of being recompiled for every event.

## [0.2.1] — 2026-08-31

### Fixed
- **A first import silently stopped at 7 days.** `listTranscripts` defaulted to `maxAgeDays = 7` and
  both call sites took the default, so only transcripts touched in the last week were ever opened —
  258 of 690 files on the machine this was found on. Everything older stayed on disk with nothing in
  the output indicating it had been skipped. The window is now `tracking.max_age_days`, still
  defaulting to 7 so a running collector keeps its cheap steady-state scan and a fresh install does
  not unexpectedly upload years of history. Set it to `3650`, restart, then set it back to import
  what is already on disk.

- **OpenCode ignored that window and kept its own.** It reads a live SQLite database rather than
  tailing files, so it has an independent history floor — also hardcoded to 7 days. Widening
  `max_age_days` therefore backfilled Claude Code and Codex completely and left OpenCode at 4 of 19
  sessions. The symptom was a lopsided event mix: 19 `user.prompted` but only 4 `session.started`,
  because the part cursor and the session-created cursor fell back to that floor differently. The
  adapter now takes the same setting.

  Together these two are why a full import of one machine went from 63 sessions to 196.

### Added
- `tracking.max_age_days` (default 7, max 3650) — see above.

## [0.2.0] — 2026-08-31

### Added
- **Parallel uploads.** `upload.concurrency` (default 4, max 8) sends that many batches at once.
  Uploading is round-trip bound rather than bandwidth bound. Measured on an 80k-event backfill:
  upload throughput ~330 -> ~627 events/s, wall clock 240s -> 175s. The end-to-end gain is smaller
  than the upload gain because reading and parsing transcripts is single-threaded and becomes the
  co-bottleneck once uploading stops being one.

  Arrival order is deliberately not preserved across in-flight batches and does not need to be: the
  server derives a session's start from `min(recorded start, earliest stored event)` and re-runs
  reconstruction after every batch, so a later batch landing first is corrected once the rest arrive.
  One `peek` covers the whole wave — peeking per batch would hand identical rows to every request and
  upload the same events `concurrency` times. A failing batch no longer abandons its siblings; the
  413 / poison-batch / backoff policy is unchanged.

  Set `upload.concurrency: 1` in `~/.agentstrack/config.yaml` to restore serial uploads.
- **OpenCode adapter.** Reads `~/.local/share/opencode/opencode.db` (honouring `$XDG_DATA_HOME`,
  `$OPENCODE_DATA_DIR` and `$OPENCODE_DB`) and emits `session.started`, `session.ended`, cumulative
  `usage.reported`, `user.prompted`, `tool.completed` / `tool.failed`, `command.executed`,
  `file.changed` and `file.read`. OpenCode records the provider's real settled cost, so it is the
  first agent whose sessions carry `cost_basis: REPORTED` rather than an estimate.

  This is a live database the OpenCode app writes to, so it is opened `readonly` + `fileMustExist`
  with `PRAGMA query_only` and a `busy_timeout`, one short query at a time. The collector never
  writes to, migrates or locks a user's data.
- **`AgentAdapter.poll()`**, an optional pull-based source for database-backed agents. `normalize()`
  is line-oriented and a SQLite file has no lines; rather than pretend otherwise, the daemon drives
  `poll()` on the same scan cycle, under the same `tracking.agents` gating, the same
  `excluded_projects` filter and the same privacy pipeline. Resumption uses the spool's meta store —
  the tailer's `(path, inode, offset)` checkpoint means nothing to a database.
- **Per-account attribution.** `session.started` and `user.prompted` now carry an optional `account`
  object: a stable opaque `key` (Claude Code's `oauthAccount.accountUuid`; OpenCode's
  `<serviceID>:<accountId>`), plus `label`, `org` and `provider`. Sessions from a personal login and
  a work login no longer merge into one identity and one bill.

  `label` and `org` are PII and are stripped by the privacy pipeline in `metadata` mode; `key` and
  `provider` always travel, so sessions still split correctly there. Credentials are never read:
  OpenCode's `account.json` holds a live API key beside the account id and only `id`/`serviceID` are
  touched, while `auth.json` is never opened.

  Events that predate the collector's start carry **no** account. These files record only who is
  signed in now, so a historical transcript cannot be attributed without guessing, and a guess that
  looks like a fact is worse than a blank.
- `SUPPORT.md`, `ROADMAP.md`, `GOVERNANCE.md`, `CODEOWNERS`, `.editorconfig`, `.gitattributes`,
  `.nvmrc`, Dependabot config and a CodeQL workflow.

### Fixed
- **`session.started.cwd` is no longer sent as an absolute path** regardless of
  `privacy.file_paths`. `cwd` *is* the project root, and it leaked the username, the client name and
  the directory tree even in `metadata` mode — where `repo.project_path` was already being dropped.
  It now follows the same rule: sent only under `file_paths: absolute`. Affected the Codex adapter
  since 0.1.0.

### Changed
- `tracking.agents` defaults to `[claude_code, codex, opencode]`.
- **`privacy.prompts: never` now strips the locally derived `derived_title` in `analytics` mode**, so
  it is possible to keep token, tool and cost analytics while sending nothing derived from a prompt.
  Previously the setting was consulted only in `full` mode, which made `never` and
  `local_summary_only` behave identically everywhere else — a privacy control that silently did
  nothing. `never` now applies in every mode, `full` included.
- **Agent versions in the registration payload are real.** `ClaudeCodeAdapter.detect()` reads the
  `version` field out of a transcript (e.g. `2.1.247`) instead of reporting the literal string
  `'detected'`. An adapter that cannot cheaply establish a version reports none, rather than a
  placeholder — which today is the case for Codex, whose `detect()` does not open a rollout to read
  `session_meta.cli_version`.
- `~/.agentstrack/` is created mode `700`, and `spool.db` with its `-wal` / `-shm` sidecars is
  `chmod`ed `600`. Previously only `config.yaml` was hardened, so on a shared host another user could
  read spooled telemetry.
- The schema contract test resolves the server repository from a sibling `../agentstrack.ai` checkout
  or `AGENTSTRACK_SERVER_REPO`, instead of an absolute path to one maintainer's machine. It still
  skips cleanly when the server repo is absent.

### Fixed
- **A partial trailing line is no longer consumed.** The tailer advances its checkpoint only to the
  last complete newline and re-reads an unterminated line whole on the next pass. Previously a line
  the agent was mid-way through writing was emitted broken and its remainder arrived orphaned, so
  both halves failed to parse and the event was lost — which happened on every live session.
- **A failed batch can no longer delete unrelated queued events.** `Spool.fail()` now scopes its
  retry-exhaustion delete to the event ids in the failing batch; it previously deleted table-wide on
  `attempts`, so one batch exhausting its retries could destroy events it had never touched.
- **`upload.max_retries: 0` no longer empties the spool.** The value is clamped to a minimum of 1.
  `attempts >= 0` matched every row, including never-attempted ones, so a config of `0` wiped the
  whole queue on the first upload failure. The config still accepts `0`–`20`; `0` behaves as `1`.

## [0.1.0] - 2026-08-26

Initial release.

### Added

- **Log tailing, not hooks.** Reads `~/.claude/projects/<slug>/<session-uuid>.jsonl` and
  `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` read-only, rescanning every 5 seconds for
  `*.jsonl` files modified in the last 7 days. The collector never installs hooks and never modifies
  `~/.claude/settings.json` or `~/.codex/hooks.json`. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are
  honoured.
- **Claude Code adapter** — human prompts (separated from tool results), `model.response` with the
  full token breakdown, tool calls, `Bash` commands, and `Edit` / `Write` / `NotebookEdit` /
  `Read` file activity. Line counts for an edit are computed locally from the tool input, as a
  multiset difference, matching what `git diff --numstat` reports.
- **Codex adapter** — `session.started` and turn boundaries, cumulative `usage.reported` snapshots,
  user messages, commands with exit code and duration, agent errors, `function_call` and
  `custom_tool_call` tool calls, and file activity parsed out of the `apply_patch` body or inferred
  narrowly from shell redirects and pager commands.
- **Schema v1 envelope** shared with the server, with a contract test in `npm test`. It always asserts
  the 18 event types and that the envelope carries no tenancy fields; the field-by-field comparison
  against the server's canonical `EVENT_SCHEMA.json` runs only when the server repository is checked
  out alongside this one, and is skipped otherwise. This release emits 14 of the schema's 18 event
  types.
- **Three privacy modes**, enforced locally before the spool write: `metadata` (counts and timings;
  titles and messages stripped), `analytics` (adds locally derived session titles — the default), and
  `full` (which still requires `privacy.prompts: full` before any prompt text is uploaded).
- **Built-in secret redaction**, 15 patterns covering Anthropic, OpenAI, GitHub, Slack, Stripe, AWS
  and Google credentials, private key blocks, JWTs, bearer headers, credentials in URLs,
  secret-shaped environment assignments, and long hex strings. Organization patterns are fetched
  from the server and applied alongside them; a malformed org pattern is skipped, not fatal.
- **Path privacy** — `never`, `relative` (default: relative to the project root, `~` for home, last
  two segments for anything else) and `absolute` (opt-in). The project root itself is transmitted
  only under `absolute`; repositories correlate by a SHA-256 of the normalized remote URL.
- **Project exclusion** by prefix via `privacy.excluded_projects`; an excluded project emits no
  events at all.
- **Offline-first SQLite spool** (WAL) at `~/.agentstrack/spool.db`, holding both the queue and the
  per-file `(path, inode, offset)` read checkpoints — so a restart resumes mid-file, a replaced or
  truncated file is re-read from the start, and nothing is lost to a network outage.
- **Batched gzip upload** — `upload.batch_size` events (default 100) every `upload.interval_seconds`
  (default 30), gzipped above 1 KB, idempotent on `event_id`. A `413` halves the batch size and
  recovers on success; retryable failures back off exponentially with jitter, capped at 5 minutes.
- **Normalized token accounting** across both agents — `input_tokens`, `cached_input_tokens`,
  `cache_creation_input_tokens`, `output_tokens`, `reasoning_output_tokens`, with reasoning treated
  as a subset of output rather than added on top.
- **Git enrichment** — branch and project root read straight out of `.git`, plus `git.commit` events
  with SHA and diffstat for commits landing inside a session's window. The remote URL is never sent,
  only a SHA-256 of its normalized form, so ssh and https clones of one repo correlate.
- **CLI**: `login`, `logout`, `start`, `stop`, `status`, `doctor`, `config`, `sync`, and
  `service install | uninstall`. Background service via launchd (macOS) or a systemd user unit
  (Linux); neither needs root.
- **`agentstrack sync --dry-run --print`** to see the exact post-redaction JSON that would be
  uploaded, and **`agentstrack config --show-effective`** to see the policy actually in force.
- **`agentstrack doctor --json`** structured diagnostics, containing no API key and no payloads —
  safe to paste into a bug report.
- **`AGENTSTRACK_HOME`** to relocate all local state (config, spool, log, pidfile).
- Config at `~/.agentstrack/config.yaml`, written mode `600`. An invalid config is a hard error
  rather than a silent fallback to defaults, so a typo cannot quietly widen your privacy mode.

### Security

- `organization_id` and `user_id` are absent from the event envelope by design; the server derives
  both from the API key, so a collector cannot name its own tenant.
- The organization privacy policy acts as a ceiling: a local config may be stricter, never looser.
  Both `login` and the daemon clamp through one shared function.
- The collector log records counts, queue depths and event ids — never prompts, code content, or
  API keys.

### Known limitations

As released. Several of these have since been fixed — see the later sections above, and
[ROADMAP.md](./ROADMAP.md) for what is still outstanding.

> **Superseded (as of 0.7.0):** `idle_timeout_seconds` is used by the collector to end quiet
> sessions (0.3.0); `session.ended` is emitted (0.3.0) and `git.branch_changed` too (0.7.0);
> the backfill window is `tracking.max_age_days` (0.2.1); `event_id` is derived from content
> (0.3.0); Node 24 is the floor (0.6.0). Still true: `process_metrics` has no effect,
> `shell_arguments: full` equals `redact_secrets`, `heartbeat` and `model.request` are not
> emitted, `task_category` is not populated, and the service installer is launchd and systemd only.

- `tracking.idle_timeout_seconds` and `tracking.process_metrics` are accepted and validated but not
  yet used by the collector; time accounting is derived server-side from the event stream.
- `privacy.shell_arguments: full` behaves the same as `redact_secrets` — secret redaction is applied
  to commands unconditionally.
- `session.ended`, `heartbeat`, `model.request` and `git.branch_changed` exist in the schema but no
  adapter emits them yet, and no adapter populates `task_category`.
- The backfill window is fixed at 7 days and is not configurable.
- `event_id` is generated per enqueue rather than derived from content, so re-reading a truncated
  transcript would produce duplicate events server-side. Retrying a batch is unaffected.
- The service installer supports launchd and systemd only. `agentstrack start --foreground` works
  anywhere Node 20+ does.

<!-- 0.2.0 and 0.4.0 have no tag: this repository's history was squashed before
     it was made public, and no commit in it carries either version. The releases
     were real (0.2.0 is on npm) and their notes stay above; the compare links
     simply skip to the neighbouring tag that does exist. -->

[Unreleased]: https://github.com/agentstrack/collector/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/agentstrack/collector/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/agentstrack/collector/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/agentstrack/collector/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/agentstrack/collector/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/agentstrack/collector/compare/v0.4.6...v0.5.0
[0.4.6]: https://github.com/agentstrack/collector/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/agentstrack/collector/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/agentstrack/collector/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/agentstrack/collector/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/agentstrack/collector/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/agentstrack/collector/compare/v0.3.0...v0.4.1
[0.4.0]: https://github.com/agentstrack/collector/compare/v0.3.0...v0.4.1
[0.3.0]: https://github.com/agentstrack/collector/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/agentstrack/collector/compare/v0.1.0...v0.2.1
[0.2.0]: https://github.com/agentstrack/collector/compare/v0.1.0...v0.2.1
[0.1.0]: https://github.com/agentstrack/collector/releases/tag/v0.1.0
