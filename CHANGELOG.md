# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A change to the event envelope or to the config file shape is a **breaking change** and will be
released as a major version, with a migration note in this file.

## [Unreleased]

### Added
- `SUPPORT.md`, `ROADMAP.md`, `GOVERNANCE.md`, `CODEOWNERS`, `.editorconfig`, `.gitattributes`,
  `.nvmrc`, Dependabot config and a CodeQL workflow.

### Changed
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

As released. Several of these have since been fixed — see `## Unreleased` above, and
[ROADMAP.md](./ROADMAP.md) for what is still outstanding.

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

[Unreleased]: https://github.com/agentstrack/collector/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/agentstrack/collector/releases/tag/v0.1.0
