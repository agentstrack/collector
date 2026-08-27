# Contributing to the AgentsTrack Collector

Thanks for being here. The most valuable contributions to this repo, in order:

1. **A new agent adapter** — one file, three methods, one redacted fixture.
2. **A redaction rule for a secret format we miss** — one regex, one test case.
3. **A bug report with a redacted fixture attached** — the fixture is what makes it fixable.

---

## Development setup

CI runs Node **20** and **22** on Ubuntu and macOS; the published package declares `engines.node >= 20`.

```bash
git clone https://github.com/agentstrack/collector.git
cd collector
npm install

npm test            # vitest run  — 95 tests today
npm run test:watch  # vitest
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/, chmod +x dist/cli.js
```

Run your local build as the real binary:

```bash
npm run build
node dist/cli.js status
# or, to get the `agentstrack` name on your PATH:
npm link
```

TypeScript is `strict` plus `noUncheckedIndexedAccess`. There is no `any` in this codebase and PRs
introducing one will be asked to remove it. Comments explain **why**, not what.

Tests live next to the code they cover, as `src/**/*.test.ts`. Fixtures live in `test/fixtures/`.

### The wire schema contract test

`src/schema.contract.test.ts` guards against this repo's copy of the event schema drifting from the
server's canonical `EVENT_SCHEMA.json` — a silent drift means ingest rejects every event in
production. Two of its three cases always run (the 18 event types, and that the envelope carries no
tenancy fields). The third, the field-by-field comparison, needs the server repository:

```bash
npm test                                    # comparison SKIPPED — no server repo found

# Option 1: check the server repo out as a sibling of this one.
#   parent/
#     collector/        <- you are here
#     agentstrack.ai/   <- resolved automatically
npm test

# Option 2: point at it explicitly, wherever it lives.
AGENTSTRACK_SERVER_REPO=~/src/agentstrack.ai npm test
```

The test resolves `$AGENTSTRACK_SERVER_REPO` first, then `../agentstrack.ai` relative to `src/`, and
looks for `EVENT_SCHEMA.json` at that root. **If neither exists it skips, it does not fail** — you do
not need the server repo to contribute, and CI runs without it. The skip is visible, which is your
confirmation that it did not silently pass:

```console
$ AGENTSTRACK_SERVER_REPO=/tmp/nope npx vitest run src/schema.contract.test.ts
 ✓ src/schema.contract.test.ts (3 tests | 1 skipped) 2ms

 Test Files  1 passed (1)
      Tests  2 passed | 1 skipped (3)
```

If you change `src/schema.ts` — a new event type, a new agent id, a new envelope field — run it with
the server repo present, and expect to change `EVENT_SCHEMA.json` in the same breath. The two
repositories share the envelope **by contract, not by a workspace link**.

---

## Running against a local API

Never test against production with your real key. `AGENTSTRACK_HOME` relocates **all** local state —
config, spool, log and pidfile — so a development run cannot touch `~/.agentstrack`:

```bash
export AGENTSTRACK_HOME=/tmp/agentstrack-dev
node dist/cli.js login at_test_xxxxxxxxxxxxxxxx_xxxx --api-url http://localhost:3001
node dist/cli.js start --foreground
```

The API key is a positional argument — there is no prompt and no environment variable for it.

To bring up the API locally see the [AgentsTrack monorepo](https://github.com/agentstrack/agentstrack)
(`pnpm up` runs the full stack including Postgres and Redis). The collector needs only
`POST /v1/collector/register`, `GET /v1/collector/config`, `POST /v1/collector/health` and
`POST /v1/events/batch`.

Checking your work with **no server at all** — this parses your real transcripts, runs the full
privacy pipeline, and prints the exact JSON that would have been uploaded:

```bash
export AGENTSTRACK_HOME=/tmp/agentstrack-dev
node dist/cli.js sync --dry-run --print
```

(The spool must already have events in it, which means a `start --foreground` run first. A `login`
against an unreachable API is fine for this — registration failing just means no `collector_id`.)

---

## Adding a new agent adapter

An adapter's job: find the agent's logs, say whether they are healthy, and turn raw log lines into
normalized events. It does **not** install hooks and does **not** write to the agent's configuration.

### Why there is no `installHooks()`

This is a hard rule of the project, not a style preference, and it has three reasons:

1. **Hook slots are already taken.** `~/.claude/settings.json` and `~/.codex/hooks.json` are shared
   config files other tools also want. Writing to them means racing other tools and owning the
   fallout when a user's own hook stops firing.
2. **The transcripts carry more.** Per-message token counts, cache-creation vs cache-read splits and
   reasoning tokens are in the log files and are not delivered to hooks. An adapter built on hooks
   could not produce cost analytics at all.
3. **Uninstall must be free.** Tailing a file leaves nothing behind. If the collector never changed
   your agent's configuration, removing it cannot break your agent.

If an agent cannot be observed by reading files it already writes, open an issue before writing code.

### The interface

`src/adapters/types.ts`:

```ts
export interface AgentAdapter {
  readonly id: string;                    // e.g. 'gemini_cli' — must be in AGENTS
  detect(): Promise<DetectionResult>;     // installed? which directories to watch?
  health(): Promise<HealthStatus>;        // readable? how many transcripts?
  normalize(line: string, ctx: NormalizeContext): NormalizedEvent[];
}

interface DetectionResult { installed: boolean; version?: string; watchPaths: string[]; note?: string }
interface HealthStatus   { healthy: boolean; filesTracked: number; lastEventAt?: string; error?: string }
interface NormalizeContext { collectorId: string; sourceFile: string }
interface NormalizedEvent {
  event: Omit<EventEnvelope, 'event_id' | 'collector_id' | 'schema_version'>;
  cwd?: string;          // used for project exclusion and git enrichment
  repo?: RepoContext;
}
```

`normalize()` is **synchronous** and takes **one line at a time**. It must never throw on
unrecognised input — agents change their log formats between releases and one unknown line must not
stop the file. Return `[]` instead. It must do no I/O and read no clock; keeping per-file parse
state in a `Map` keyed by `ctx.sourceFile` is fine and is what the Codex adapter does for the session
id and model that only appear on the first lines of a rollout.

### Steps

1. **Add the id** to `AGENTS` in [`src/schema.ts`](./src/schema.ts), `snake_case`. The same id must
   exist in the server's `AgentId` enum (`packages/event-schema/src/enums.ts` in the monorepo) or
   ingest will reject every event.
2. **Create `src/adapters/<agent>.ts`.** Use the agent's documented log location, honouring its own
   home-directory environment variable if it has one (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Do not scan
   the filesystem hunting for logs.
   - `detect()` returns directories in `watchPaths`; the daemon walks them recursively (max depth 5)
     for `*.jsonl` modified in the last 7 days.
   - `health()` runs on every `status` and `doctor` — keep it cheap.
3. **Register it** in `buildAdapters()` in [`src/daemon.ts`](./src/daemon.ts), and add the id to the
   `tracking.agents` default in [`src/config.ts`](./src/config.ts) only if it should be on by default.
4. **Emit existing event types.** Map onto the 18 in [`docs/EVENT_SCHEMA.md`](./docs/EVENT_SCHEMA.md);
   do not invent one. Token fields must map onto `TokenUsage` (`input_tokens`, `cached_input_tokens`,
   `cache_creation_input_tokens`, `output_tokens`, `reasoning_output_tokens`), and reasoning tokens
   are a **subset** of output tokens — never add them on top. If the agent reports **cumulative**
   totals, emit `usage.reported` with `cumulative: true` so the server treats it as a gauge.
5. **Use the payload keys the privacy pipeline knows.** This is the part that is easy to get wrong.
   [`src/privacy/pipeline.ts`](./src/privacy/pipeline.ts) only processes specific keys:

   | Put this in | And it gets |
   |---|---|
   | `payload.path` | path normalization per `privacy.file_paths` |
   | `payload.repo.project_path` | dropped unless `file_paths: absolute` |
   | `payload.command` | secret redaction, and truncation under `shell_arguments: never` |
   | `payload.prompt_text` | deleted in every mode except `full` + `prompts: full` |
   | `payload.derived_title` | deleted in `metadata`, and in `analytics` under `prompts: never` (not in `full` — see ROADMAP); redacted otherwise |
   | `payload.message` | deleted in `metadata`, redacted otherwise |
   | `payload.content`, `diff`, `old_string`, `new_string` | deleted unless `code_content: full` |

   A new free-text field under a **new** key bypasses redaction entirely. If you need one, add it to
   `TEXT_KEYS` in the pipeline in the same PR, with a test.
6. **Derive line counts in the adapter.** The pipeline deletes `old_string` / `new_string` / `content`
   before upload, so no later stage can recover them. Both existing adapters compute
   `lines_added` / `lines_removed` at normalize time — see `countEditLines()` in `claude.ts` and
   `parseApplyPatch()` in `codex.ts`.
7. **Add a fixture and a test.** Fixture at `test/fixtures/<agent>-session.jsonl`, test alongside the
   other adapter tests in `src/adapters/`.
8. **Document it** in the README's supported-agents table, including the per-signal row — say
   honestly what the agent's log does *not* contain.

### Adapter contributions must include a redacted fixture

**A PR adding an adapter will not be merged without one**, and it must be scrubbed by hand. Fixtures
are how adapters keep working when an agent changes format, and an unredacted session log is a data
breach waiting in git history.

Before committing a fixture:

- Replace prompt text with obvious placeholders.
- Replace absolute paths with `/home/example/project/…`.
- Replace every id, session UUID and repo name with a synthetic value.
- Delete any credential-shaped string outright — do not rely on our redaction to catch it.
- Keep it small: 20–60 lines pins the format fine. Include at least one malformed line and one
  line of a type you do not handle; the "never throws" test needs them.

`test/fixtures/*.local.jsonl` is gitignored. Use that name while working from a real session, and
commit only the scrubbed copy.

---

## Adding a redaction rule

1. Add it to `BUILTIN_RULES` in [`src/privacy/redact.ts`](./src/privacy/redact.ts). Order matters —
   the list is most-specific first, so a token matching two rules is labelled by the precise one.
2. Use a global regex (`/…/g`). The redactor resets `lastIndex` before every use, so a stateful
   global regex is safe here, but do not rely on that elsewhere.
3. Add a **positive** case and a **near-miss negative** case to `src/privacy/redact.test.ts`. A rule
   that also eats ordinary text is worse than a missing rule — it silently destroys analytics.
4. Update the rule table in the README.

---

## Testing expectations

| Change | Test required |
|---|---|
| New adapter | Fixture + a `normalize()` test asserting event types, ordering and token totals, plus the "never throws on garbage" case |
| New redaction rule | One positive case and one near-miss negative case |
| Privacy behaviour | A test asserting the field is **absent**, not merely empty |
| Config key | A test that the default applies and that an invalid value is rejected |
| Spool / tailer change | A test using a real temp file and a real SQLite spool — these are the durability guarantees |
| Bug fix | A test that fails on `main` and passes with the fix |

Run `npm test && npm run typecheck` before pushing. CI runs both on Node 20 and 22, on Ubuntu and
macOS; a red matrix cell blocks merge.

**Tests must never contain real credentials, real prompts, or real paths** — including strings that
merely look credential-shaped in a fixture copied from your own machine.

---

## Commits and pull requests

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(adapters): add gemini_cli adapter
fix(spool): keep a partial trailing line unconsumed
docs(readme): document AGENTSTRACK_HOME
chore(deps): bump better-sqlite3 to 11.7.0
test(privacy): cover azure connection strings
```

Scopes in use: `adapters`, `privacy`, `spool`, `upload`, `cli`, `config`, `service`, `docs`, `deps`.
A `feat!:` or a `BREAKING CHANGE:` footer is required for any change to the wire schema or the config
file shape.

### PR checklist

- One logical change per PR. A new adapter is one PR; a refactor it happens to need is another.
- Fill in the [pull request template](./.github/PULL_REQUEST_TEMPLATE.md) — the privacy question in it
  is not a formality.
- Update the README and `docs/EVENT_SCHEMA.md` when behaviour or the wire format changes.
- Add an entry under `## Unreleased` in [CHANGELOG.md](./CHANGELOG.md).
- No new runtime dependencies without discussion in an issue first. This package is installed globally
  on developers' machines; every dependency is supply-chain surface.

### Things that will be sent back

- Uploading anything not documented in `docs/EVENT_SCHEMA.md`.
- A new payload field carrying free text that does not go through `TEXT_KEYS`.
- Writing to the user's agent configuration (`~/.claude/settings.json`, `~/.codex/hooks.json`, or any
  equivalent).
- Logging prompts, code content, or API keys — including inside exception messages.
- Weakening a privacy default "for better analytics".
- Any per-developer scoring or ranking. It is an explicit product decision that this does not exist.

---

## Reporting security issues

Do **not** open a public issue. See [SECURITY.md](./SECURITY.md) — mail security@agentstrack.ai.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). Report concerns to
conduct@agentstrack.ai.

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE).
