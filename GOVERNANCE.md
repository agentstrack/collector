# Governance

This is a young project with a small number of maintainers. There is no foundation, no steering
committee, no elected board, and no formal voting procedure — inventing one would be theatre. This
document says what actually happens, so that a contributor can predict how their PR will be handled
and knows what to do when they disagree.

It will get more formal as the project grows. That is a good problem to have and this file will be
updated when it arrives.

## Who decides

The maintainers listed in [CODEOWNERS](./.github/CODEOWNERS) — currently AgentsTrack, which sponsors
the project's development. The collector is Apache-2.0 and will remain so: it is the component that
runs on a developer's machine and reads their files, and it has to be auditable to be trustworthy.
The licence is not up for revision.

Sponsorship means the maintainers have a product context that a drive-by contributor does not, and it
means their availability follows a company's priorities. It does **not** mean the server's roadmap
overrides a technical objection raised here.

## How decisions get made

**Lazy consensus, and most changes never need more than that.** Open a PR; if a maintainer approves
and nobody objects, it merges. Comments are the mechanism — an unanswered concern from anyone, not
just a maintainer, blocks a merge until it is answered. "Answered" can mean "you're right, changed
it" or "here's why I disagree"; it cannot mean waiting for it to scroll away.

**Where discussion happens first, before code:**

- A change to the **event envelope** or the **config file shape**. Both are breaking changes, both are
  shared with the server by contract, and both need a migration note.
- A change to a **privacy default**, or anything that causes something new to leave the machine.
- A **new runtime dependency.** This package is installed globally on developers' machines.
- Anything on the "Not on the roadmap" list in [ROADMAP.md](./ROADMAP.md).

For those, open an issue and get agreement on the approach. A PR that arrives cold with a widened
default in it will be sent back regardless of how good the code is, and that is a waste of your
evening.

**When people disagree** and it does not resolve in the thread, the maintainers decide, in the issue,
in writing, with the reason. Not in a DM, and not by silence. If the decision goes against you, it
should at minimum be clear *why*, and the reasoning should be reusable next time.

**Some things are decided already** and are not reopened by a PR: no hooks, no reading the source
tree, no per-developer scoring, no weakening a privacy default for better analytics. Each has a
recorded reason in [CONTRIBUTING.md](./CONTRIBUTING.md) or [ROADMAP.md](./ROADMAP.md). New evidence
can reopen any of them; a preference cannot.

## Review requirements

- **Every PR needs one maintainer approval.** Nobody self-merges their own change.
- **Two approvals**, or one plus an explicit sign-off from someone who did not write it, for changes
  under `src/privacy/`, `src/queue/`, `src/schema.ts`, and anything touching `.github/workflows/` or
  `package.json`. These are the trust story, the durability guarantees, the wire contract, and the
  paths that can publish to npm — see [CODEOWNERS](./.github/CODEOWNERS).
- **CI green is not negotiable.** The full matrix — Node 20 and 22, Ubuntu and macOS — plus typecheck,
  tests and a build. A red cell blocks merge; a flaky test is a bug to fix, not a reason to re-run.
- The [PR template](./.github/PULL_REQUEST_TEMPLATE.md)'s privacy question gets a real answer. It is
  not a formality.

## Becoming a maintainer

There is no application form and no probation period. The path is:

1. **Land a few non-trivial PRs.** An agent adapter, a redaction rule with real coverage, a fix to the
   spool or the tailer with a test that fails without it. Roughly three, but it is about substance,
   not a counter.
2. **Review other people's work** — usefully. Spotting that a new payload field bypasses `TEXT_KEYS`
   is worth more than a dozen approvals.
3. **Show the judgement.** The recurring one here is knowing when a change makes something leave the
   machine that did not before, and saying so unprompted.

At that point a maintainer proposes you in an issue and, absent objection from the others within a
week, you get commit access and a line in CODEOWNERS. There is no vote because there is nobody to
outvote.

Maintainers who have been inactive for around six months are moved to an emeritus line in CODEOWNERS,
with a heads-up first. It is bookkeeping so review requests reach people who will see them — it is not
a judgement, and coming back is a message away.

**Trusted without being a maintainer:** a contributor who owns one adapter is the person whose opinion
decides questions about that adapter. That is worth having and does not require commit access.

## Releases

Cut when there is something worth shipping. There is no calendar cadence, because a project this size
that promises monthly releases either ships empty ones or misses them.

- **Semantic versioning.** A change to the event envelope or the config file shape is a **major**, with
  a migration note in [CHANGELOG.md](./CHANGELOG.md). Pre-1.0, only the latest minor line gets security
  fixes (see [SECURITY.md](./SECURITY.md)).
- **The changelog is written as changes land**, under `## Unreleased`, by the person landing them —
  not reconstructed from git log at release time.
- **Releasing is a tag.** Pushing `vX.Y.Z` runs the release workflow: the full verification matrix,
  a check that the tag matches `package.json`, then `npm publish --provenance` and a GitHub release.
  The version is bumped in a normal PR beforehand.
- **Security fixes ship on their own**, as fast as the timelines in SECURITY.md, without waiting to be
  bundled with features.
- Only maintainers can publish. The npm token lives in a protected GitHub environment, and the
  provenance attestation ties every published tarball to the workflow run and commit that produced it
  — so anyone can verify that what is on npm was built from what is in this repository.

## Code of Conduct

The [Contributor Covenant](./CODE_OF_CONDUCT.md) applies to everyone here, maintainers included and
maintainers first. Report concerns to conduct@agentstrack.ai. Enforcement is by the maintainers,
excluding anyone the report concerns.

## Changing this document

By PR, like anything else, with a maintainer approval and a week for objections. If the change
concentrates decision-making power, say so in the PR description explicitly rather than leaving a
reader to work it out from the diff.
