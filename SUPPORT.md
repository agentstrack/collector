# Getting help

Four places, and the difference between them matters — a vulnerability filed as a public bug is a
disclosure, and a usage question filed as a bug sits in a triage queue instead of getting answered.

| You have | Go to |
|---|---|
| A question — "is this supposed to…", "how do I…", "why is my queue at 4000" | [Discussions](https://github.com/agentstrack/collector/discussions) |
| Something is broken, and you can describe what you expected | [Bug report](https://github.com/agentstrack/collector/issues/new?template=bug_report.yml) |
| An agent that isn't supported | [Agent support request](https://github.com/agentstrack/collector/issues/new?template=agent_support.yml) |
| An idea for something new | [Feature request](https://github.com/agentstrack/collector/issues/new?template=feature_request.yml) |
| A **security vulnerability** | **Not an issue.** [SECURITY.md](./SECURITY.md) — private advisory or security@agentstrack.ai |

This repository is the **collector** — the CLI that runs on your machine. Questions about the
dashboard, billing, the API, or data you see server-side belong with the AgentsTrack service, not
here. If you are not sure which side a problem is on, `agentstrack doctor` will usually tell you: if
it reports the API unreachable or a `4xx`, the problem is between you and the server.

## Try this first — it answers most of them

```bash
agentstrack doctor
```

It checks every failure mode in the README's troubleshooting section: config present, key present,
device registered, transcripts found and recent, API reachable, queue draining. It exits non-zero
when something is wrong. The [README](./README.md#troubleshooting) explains each check and what to do
about it.

Second-most-useful, when the question is "is it collecting the right thing":

```bash
agentstrack sync --dry-run --print   # exactly what would be uploaded, post-redaction. Sends nothing.
agentstrack config --show-effective  # the policy actually in force, defaults included
```

## What makes a bug report fixable

The single highest-value thing you can attach is **`agentstrack doctor --json`**:

```bash
agentstrack doctor --json
```

It is the version, the Node version, the platform, whether you are configured and logged in, your
privacy mode, whether the API is reachable, the queue depth, and per-agent detection and transcript
counts — the entire state we would otherwise spend three round-trips asking you for. It contains **no
API key, no prompt text, and no path inside a project**, so it is safe to paste into a public issue.
Please do paste the whole thing rather than the line you think is relevant.

Beyond that, a report we can act on has:

1. **What you expected and what happened.** "Sessions from yesterday never appeared in the dashboard",
   not "sync is broken".
2. **The exact command and its full output**, including the parts that look like noise.
3. **Relevant log lines** from `~/.agentstrack/collector.log`. It records counts, queue depths and
   event ids — never payloads, prompts, code or keys — which is what makes it safe to attach:
   ```bash
   grep -i "error\|failed\|rejected" ~/.agentstrack/collector.log | tail -20
   ```
4. **Which agent and which version** — Claude Code and Codex log different things, and adapter
   formats drift between agent releases. A bug that only reproduces on one agent's new release is a
   different bug from one that reproduces on both.
5. **A redacted fixture, if a transcript line is involved.** This is the difference between a report
   we can guess at and one we can write a failing test for. Scrub it by hand — placeholders for
   prompts, `/home/example/project/…` for paths, synthetic ids, and delete anything
   credential-shaped outright. [CONTRIBUTING.md](./CONTRIBUTING.md#adapter-contributions-must-include-a-redacted-fixture)
   has the checklist.

**Never paste a real prompt, a real credential, or an unredacted session log** into an issue. If a
bug can only be shown with real content, say so in the issue and we will move it somewhere private —
do not attach it and hope.

## Response expectations

This is a small project. Issues and discussions are read, but nobody is on call for them: expect days,
not hours, and expect a triage question before a fix. The exceptions are in
[SECURITY.md](./SECURITY.md), which commits to real timelines for vulnerabilities.

A bug report with `doctor --json` and a redacted fixture attached tends to get fixed. One without
tends to get a request for `doctor --json` and a redacted fixture.

## Commercial support

There is none for the collector, and no paid tier that gets a faster answer here. The collector is
Apache-2.0 and community-supported. Support arrangements for the AgentsTrack service are a matter for
the service, not this repository.
