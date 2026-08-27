# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ Security fixes |
| < 0.1 | ❌ Pre-release, unsupported |

While the collector is pre-1.0 we support the latest minor line only. Please upgrade before
reporting — `npm install -g @agentstrack/collector@latest`.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security problem.**

Email **security@agentstrack.ai**, or use GitHub's
[private vulnerability reporting](https://github.com/agentstrack/collector/security/advisories/new)
on this repository. If you prefer an encrypted channel, send a first message with no details and we
will reply with a key.

Please include:

- What the vulnerability lets an attacker do, and who the attacker has to be.
- Affected version (`agentstrack --version`) and platform.
- Reproduction steps, or a proof of concept.
- Any suggested fix.

Please **do not** include real credentials, real prompt content, or an unredacted session log. A
synthetic reproduction is always sufficient, and we would rather not receive your secrets.

## Response times

| Stage | Target |
|---|---|
| Acknowledgement | 2 business days |
| Initial assessment and severity | 5 business days |
| Fix released (high / critical) | 14 days from confirmation |
| Fix released (medium / low) | Next scheduled release |
| Public advisory | After the fix ships, coordinated with you |

We will update you at least weekly while an issue is open, and we credit reporters in the advisory
and the changelog unless you ask us not to. There is no paid bounty program.

---

## Threat model

The collector is a CLI that runs **as the developer, on the developer's machine**, with no elevated
privileges. It never needs `sudo`, and the background service is a per-user launchd agent or systemd
user unit — not a system daemon.

### What it holds

One long-lived API key, in `~/.agentstrack/config.yaml`, written mode `600`. The key authorizes
ingest for one user in one organization. The server derives `organization_id` and `user_id` from it,
so a stolen key can write events into that user's history but cannot read another tenant's data and
cannot impersonate a different org. Revoke a suspect key in the dashboard and run
`agentstrack login` again with a new one.

The key is masked in `agentstrack config`, absent from `agentstrack doctor --json`, and never written
to `collector.log`.

### What it reads

Agent transcripts, read-only:

- `~/.claude/projects/**/*.jsonl` (or `$CLAUDE_CONFIG_DIR`)
- `~/.codex/sessions/**/*.jsonl` (or `$CODEX_HOME`)

Only `*.jsonl` files modified in the last 7 days, walked to a maximum depth of 5. It does not read
your source tree, does not attach to processes, and does not modify your agent configuration — it
installs no hooks and never writes to `~/.claude/settings.json` or `~/.codex/hooks.json`.

It also runs `git log --numstat --no-merges` in repositories a session touched, when
`tracking.git_metadata` is on, to recover commit SHAs and diffstats. That is the only subprocess it
spawns other than `launchctl` / `systemctl` during service install.

### What it sends

Only what is documented in [`docs/EVENT_SCHEMA.md`](./docs/EVENT_SCHEMA.md), over HTTPS, to the
`api_url` in your config, with `Authorization: Bearer <api_key>`.

**No prompt text and no code content is uploaded in `metadata` or `analytics` mode.** In those modes
the relevant payload fields are deleted on your machine before the event is written to the spool — so
the guarantee does not depend on the server behaving, or on the network. In `analytics` mode a
session title is derived locally and the prompt it came from is discarded. Uploading prompt text
requires `privacy.mode: full` **and** `privacy.prompts: full`; uploading file contents requires
`privacy.mode: full` **and** `privacy.code_content: full`. Both are off by default.

`privacy.prompts` is a ceiling in its own right rather than a switch that only matters in `full`:
setting it to `never` suppresses both the prompt text and the locally derived `derived_title` in
every mode, `full` included, so nothing derived from a prompt reaches the spool.

Secret redaction (15 built-in patterns plus any your organization adds) runs before the spool write,
so a credential that appeared in a captured command line is never persisted to `spool.db` either.

### Local state, and its limits

| Path | Mode | Contents |
|---|---|---|
| `~/.agentstrack/` | `700` | The directory itself, created owner-only |
| `~/.agentstrack/config.yaml` | `600` | API key, collector id, privacy policy |
| `~/.agentstrack/spool.db` (+ `-wal`, `-shm`) | `600` | Post-redaction events pending upload |
| `~/.agentstrack/collector.log` | default umask | Counts, queue depths, error strings — never payloads |
| `~/.agentstrack/collector.pid` | default umask | Pid of a foreground collector |

The directory is created mode `700`, and the two files that can carry anything sensitive — the
config, which holds the API key, and the spool, which holds un-uploaded telemetry — are `chmod`ed
`600` by the collector itself, SQLite's WAL and SHM sidecars included. The directory mode is the
control that matters for the rest: the log and the pidfile are written at your umask, but on a shared
host no other user can traverse into `~/.agentstrack` to reach them.

Two residual notes, neither of which is a gap in the collector:

- A **pre-existing** `~/.agentstrack` is `chmod`ed on startup, but if it is owned by another user that
  call fails and is ignored — there is nothing useful to do about a directory you do not own. `ls -ld
  ~/.agentstrack` is worth a glance after a `sudo` run.
- These are Unix permission bits. On a filesystem that does not honour them — a share mounted with
  fixed modes, some network filesystems — they are advisory.

`agentstrack logout --purge` deletes the spool database (and its WAL/SHM files) along with the key.

### Out of scope

- Anything requiring an attacker to already have code execution as your user, or root, on your
  machine. At that point they have your API key regardless of what we do.
- Vulnerabilities in Claude Code, Codex, or other agents themselves.
- Issues in the AgentsTrack server, which are handled at the same address but tracked separately.
- Denial of service against your own collector by writing a huge transcript file.

### In scope, and interesting to us

- Any path by which content is uploaded that the effective privacy mode should have suppressed.
- Any payload field that reaches the network without passing the redaction pipeline.
- A credential format that reaches the network unredacted (a missing pattern is a bug report; a
  *bypass* of an existing pattern is a security report).
- The API key appearing in a log, an error message, a crash dump, or `doctor` output.
- Path traversal or symlink handling in log tailing that lets a crafted transcript cause the
  collector to read a file outside the watched directories.
- An org privacy ceiling being applied as a floor — i.e. a server response widening what a stricter
  local config sends.
- Insecure permissions on anything the collector writes, or a path by which `~/.agentstrack`,
  `config.yaml` or `spool.db` ends up wider than the modes in the table above.
- Dependency vulnerabilities with a demonstrable path to exploitation here.
