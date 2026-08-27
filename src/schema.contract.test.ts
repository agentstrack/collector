import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EVENT_TYPES, AGENTS, PRIVACY_MODES, SCHEMA_VERSION, EventEnvelope } from './schema.js';

/**
 * Contract test.
 *
 * This repository ships its own copy of the wire schema so it can be cloned and
 * built standalone. That copy can drift from the server's canonical
 * EVENT_SCHEMA.json, and a silent drift means events are rejected in
 * production. When the server repo is present locally, assert they agree.
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

  it.skipIf(!existsSync(CANONICAL))('matches the server canonical schema', () => {
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
});
