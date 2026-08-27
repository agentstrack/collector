## What this changes

<!-- One or two sentences. Link the issue: Closes #123 -->

## Why

<!-- The problem, not the patch. If it is obvious from the issue, link it and move on. -->

## Type of change

- [ ] Bug fix
- [ ] New agent adapter
- [ ] New or updated redaction rule
- [ ] Feature
- [ ] Documentation
- [ ] Chore / dependencies
- [ ] **Breaking** — changes the event envelope or the config file shape

## Privacy review

Every PR answers this. It is not a formality — the collector's whole value is that it can be
trusted with a developer's machine.

- [ ] This change **does not** cause anything new to leave the machine.
- [ ] Or: it does, and here is exactly what, why it is opt-in, and where it is documented:

<!-- describe here -->

- [ ] No new payload field bypasses the privacy pipeline — free text goes under a key in
      `TEXT_KEYS`, paths under `payload.path`, commands under `payload.command`.
- [ ] Nothing new is logged that could contain a prompt, code content, or an API key.
- [ ] `docs/EVENT_SCHEMA.md` is updated if the wire format changed.
- [ ] The collector still does not install hooks or write to `~/.claude/settings.json` /
      `~/.codex/hooks.json`.

## Testing

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds
- [ ] New tests cover the change (a bug fix has a test that fails on `main`)

<!-- For an adapter PR: -->
- [ ] A **redacted** fixture is committed at `test/fixtures/<agent>-session.jsonl`
- [ ] The fixture contains no real prompts, paths, ids, repo names, or credentials
- [ ] `normalize()` does no I/O and reads no clock (per-file parse state in a `Map` is fine),
      and is tested from the fixture

How you verified it manually:

```
# e.g.
# AGENTSTRACK_HOME=/tmp/at-dev node dist/cli.js sync --dry-run --print
```

## Docs and changelog

- [ ] README updated if a command, flag, config key, or supported agent changed
- [ ] `CHANGELOG.md` has an entry under `## Unreleased`
- [ ] Commit messages follow Conventional Commits (`feat(adapters): …`, `fix(spool): …`)

## Anything reviewers should know

<!-- Tradeoffs, follow-ups you deliberately left out, things you are unsure about. -->
