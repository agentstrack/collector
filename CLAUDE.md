# CLAUDE.md — AgentsTrack Collector

The collector that tails coding-agent transcripts and uploads privacy-filtered telemetry.
Published to npm as `@agentstrack/collector`, binary `agentstrack`. Apache-2.0, public repo.

**Precedence:** this file → `~/Documents/master-vault/Engineering Standards/` → general best practice.
`CONTRIBUTING.md` is the public contributor guide and stays authoritative on code conventions
(Conventional Commits, scopes, the PR checklist, what gets sent back) — this file covers what only a
maintainer needs.

The server lives in a **separate repository**: `../agentstrack.ai`. The event envelope is shared by
contract (`src/schema.ts` + `schema.contract.test.ts`), not by workspace link — changing the envelope
means changing both repos.

## Releasing — push a tag, never `npm publish`

`.github/workflows/release.yml` fires on any `v*.*.*` tag and does the whole release: verify
(typecheck, test, build on Ubuntu + macOS), then `npm publish --provenance --access public`, then
`gh release create`. There is nothing to run by hand.

```bash
# 1. bump package.json, move CHANGELOG's Unreleased section under the new version
# 2. commit, push master and develop
git tag -a v0.5.0 -m "0.5.0 — <the headline>"
git push origin v0.5.0          # this is the release
gh run watch -R agentstrack/collector
```

**Publishing by hand costs provenance.** `--provenance` needs the workflow's OIDC token to link the
tarball to the commit that produced it; a local `npm publish` cannot mint one, and provenance cannot
be added to a version after the fact. It also makes the tag's own run fail — npm refuses to publish
over an existing version — so a hand-publish turns a green release into a red one that already did
its job. 0.4.1 was published this way and has no attestation; the fix is to let the next tag do it.

The workflow hard-fails when the tag disagrees with `package.json`, deliberately: the wrong version
under the right name cannot be undone.

## Facts worth not rediscovering

- **`gh` needs the `ddcodepl` account.** `icmdamian` has read-only access to `agentstrack/collector`,
  and `gh` misreports that as `"workflow" scope may be required` — a scope refresh will not help.
  `gh auth switch -u ddcodepl`, do the work, switch back. Git push is unaffected (SSH, not `gh`).
- **`master` and `develop` both exist and both matter.** CI and CodeQL run on both; `master` is the
  default branch. Releases are cut from `master`.
- **Node floor is 22** (`engines`, `.nvmrc`); CI tests 22 and 24, the release job runs 24.
- **npm's packument is CDN-cached for a minute or two after a publish.** `npm view` reporting the old
  version right after a successful publish is staleness, not failure — confirm with
  `curl -s https://registry.npmjs.org/@agentstrack%2Fcollector | jq '.["dist-tags"]'`.
- **0.2.0 and 0.4.0 have no tags and never will.** The history was squashed before the repo went
  public and no commit carries either version; their notes are folded into the v0.2.1 and v0.4.1
  releases. Do not try to reconstruct them.

## Invariants

These are the reasons this package is installable, not preferences.

1. **Privacy is enforced here, before upload** — the server is not the first line of defence. In
   `metadata` mode there is no content to leak because it was discarded locally.
2. **Redact before you truncate.** Cutting a value first can split a secret into a fragment that no
   pattern recognises, and the fragment ships. This was a real 0.4.1 security fix; it applies to any
   new derived field, not just `derived_title`.
3. **Never log prompts, code content, or API keys** — including inside exception messages.
4. **Never write to the user's agent config.** The collector tails files; it installs no hooks and
   touches no `settings.json`.
5. **Tolerate unknown fields, skip unparseable lines.** Adapter formats drift between agent releases;
   one bad line must not abort the file.
6. **No new runtime dependencies without discussion.** This installs globally on developer machines —
   every dependency is supply-chain surface.
