import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EVENT_TYPES, AGENTS, PRIVACY_MODES, SCHEMA_VERSION, EventEnvelope } from './schema.js';
import { ClaudeCodeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { OpenCodeAdapter } from './adapters/opencode.js';
import type { NormalizedEvent } from './adapters/types.js';
import { seedOpenCodeFixture } from '../test/fixtures/opencode-db.js';

/**
 * Contract test.
 *
 * This repository ships its own copy of the wire schema so it can be cloned and
 * built standalone. That copy can drift from the server's canonical
 * EVENT_SCHEMA.json, and a silent drift means events are rejected in
 * production. When the server repo is present locally, assert they agree —
 * enums against EVENT_SCHEMA.json, and every adapter fixture's output against
 * the server's own per-event payload schemas.
 */
/**
 * The server repo is a sibling checkout, or wherever AGENTSTRACK_SERVER_REPO
 * points. Previously this was an absolute path to one maintainer's machine,
 * which both leaked that layout into a public repo and made the drift guard a
 * silent no-op for every contributor and for CI.
 */
const serverRepo =
  process.env['AGENTSTRACK_SERVER_REPO'] ??
  resolve(import.meta.dirname, '../../agentstrack.ai');
const CANONICAL = join(serverRepo, 'EVENT_SCHEMA.json');
const SERVER_SCHEMA = join(serverRepo, 'packages/event-schema/src/index.ts');
// Configured explicitly means required: a missing repo is then a failure, not a skip.
const serverRequired = Boolean(process.env['AGENTSTRACK_SERVER_REPO']);
const serverPresent = existsSync(CANONICAL) && existsSync(SERVER_SCHEMA);

const collectorId = '00000000-0000-4000-8000-000000000000';
const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '../test/fixtures', name), 'utf8').split('\n').filter(Boolean);

/** Everything the three adapters produce from their fixtures, as wire envelopes. */
async function fixtureEnvelopes(): Promise<Record<string, unknown>[]> {
  const events: NormalizedEvent[] = [];
  const ctx = { collectorId, sourceFile: '/tmp/f.jsonl' };
  const claude = new ClaudeCodeAdapter();
  for (const line of fixture('claude-session.jsonl')) events.push(...claude.normalize(line, ctx));
  const codex = new CodexAdapter();
  for (const line of fixture('codex-session.jsonl')) events.push(...codex.normalize(line, ctx));

  const dir = mkdtempSync(join(tmpdir(), 'agentstrack-contract-'));
  try {
    seedOpenCodeFixture(dir);
    const store = new Map<string, string>();
    events.push(
      ...(await new OpenCodeAdapter(dir).poll({
        collectorId,
        getMeta: (k) => store.get(k) ?? null,
        setMeta: (k, v) => void store.set(k, v),
      })),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return events.map((e) => ({
    ...e.event,
    event_id: randomUUID(),
    collector_id: collectorId,
    schema_version: SCHEMA_VERSION,
  }));
}

describe('wire contract', () => {
  it('envelope rejects an event that names its own tenant', () => {
    // The server derives organization_id/user_id from the API key. A collector
    // that could set them would be able to write into another org.
    const parsed = EventEnvelope.parse({
      event_id: '00000000-0000-4000-8000-000000000001',
      schema_version: SCHEMA_VERSION,
      occurred_at: '2026-08-26T10:00:00.000Z',
      collector_id: '00000000-0000-4000-8000-000000000000',
      session_id: 's1',
      agent: 'claude_code',
      event_type: 'heartbeat',
      payload: {},
      organization_id: 'attacker-org',
      user_id: 'attacker-user',
    });
    expect(parsed).not.toHaveProperty('organization_id');
    expect(parsed).not.toHaveProperty('user_id');
  });

  it('declares exactly the 18 blueprint event types', () => {
    expect(EVENT_TYPES).toHaveLength(18);
  });

  it.skipIf(!serverPresent && !serverRequired)('matches the server canonical schema', () => {
    expect(serverPresent, `AGENTSTRACK_SERVER_REPO=${serverRepo} has no EVENT_SCHEMA.json / event-schema package`).toBe(true);
    const canonical = JSON.parse(readFileSync(CANONICAL, 'utf8')) as {
      schema_version: number;
      event_types: string[];
      enums: { agent: string[]; privacy_mode: string[] };
      envelope: Record<string, unknown>;
    };

    expect(SCHEMA_VERSION).toBe(canonical.schema_version);
    expect([...EVENT_TYPES].sort()).toEqual([...canonical.event_types].sort());
    expect([...AGENTS].sort()).toEqual([...canonical.enums.agent].sort());
    expect([...PRIVACY_MODES].sort()).toEqual([...canonical.enums.privacy_mode].sort());
    // The canonical envelope must not carry tenancy fields either.
    expect(canonical.envelope).not.toHaveProperty('organization_id');
    expect(canonical.envelope).not.toHaveProperty('user_id');
  });

  it.skipIf(!serverPresent && !serverRequired)('every adapter fixture event passes the server payload schemas', async () => {
    expect(serverPresent, `AGENTSTRACK_SERVER_REPO=${serverRepo} has no event-schema package`).toBe(true);
    // The server package is TypeScript source with its own zod; vitest
    // transforms it in place, so no build step is needed on either side.
    const { safeParseEvent } = (await import(SERVER_SCHEMA)) as {
      safeParseEvent: (input: unknown) => { ok: true } | { ok: false; error: string };
    };
    const envelopes = await fixtureEnvelopes();
    expect(envelopes.length).toBeGreaterThan(20);
    const rejected = envelopes.flatMap((envelope) => {
      const result = safeParseEvent(envelope);
      return result.ok ? [] : [{ agent: envelope['agent'], event_type: envelope['event_type'], error: result.error }];
    });
    expect(rejected).toEqual([]);
  });
});
