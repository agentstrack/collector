import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../adapters/claude.js';
import { CodexAdapter } from '../adapters/codex.js';
import { applyPrivacy } from './pipeline.js';
import { deriveTitle } from '../sessions/title.js';
import { Config } from '../config.js';
import { PRIVACY_MODES } from '../schema.js';

/**
 * Regression for the 0.4.1 leak: any text that is truncated BEFORE the privacy
 * pipeline runs can be cut through the middle of a secret, and neither half
 * matches its pattern any more, so the pipeline's later pass finds nothing to
 * redact and the fragment is uploaded.
 */
const SECRET = 'sk-ant-api03-' + 'A'.repeat(80);
const ctx = { collectorId: '00000000-0000-4000-8000-000000000000', sourceFile: '/tmp/f.jsonl' };

/**
 * Every 12-character window of the key. Twelve is well under the length the
 * detector needs to fire, which is the whole point: the fragment a truncation
 * leaves behind is exactly the one no pattern will catch on a second pass.
 */
const fragments = () =>
  Array.from({ length: SECRET.length - 12 + 1 }, (_, i) => SECRET.slice(i, i + 12));

const config = (mode: (typeof PRIVACY_MODES)[number]) =>
  Config.parse({ privacy: { mode, prompts: 'full' } });

describe('truncation never bisects a secret', () => {
  // 100 characters of prefix put the key across deriveTitle's 120-char cut.
  const prompt = 'x'.repeat(100) + ' ' + SECRET;

  it('a title cut through a secret ships no fragment of it, in any mode', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: prompt },
      uuid: 'm1',
      timestamp: '2026-08-26T10:00:00.000Z',
      cwd: '/Users/dev/Web/api',
      sessionId: '06f3470f-d924-4552-b3ee-3f8924286cec',
    });
    const [prompted] = new ClaudeCodeAdapter().normalize(line, ctx);
    expect(prompted?.event.payload['derived_title']).toBeDefined();

    for (const mode of PRIVACY_MODES) {
      const { event } = applyPrivacy(structuredClone(prompted!.event), { config: config(mode) });
      const serialized = JSON.stringify(event);
      for (const fragment of fragments()) expect(serialized, mode).not.toContain(fragment);
      // The tally still reports that a key was typed — that is metadata.
      expect(event.payload['secrets_redacted'], mode).toEqual([{ kind: 'anthropic_key', count: 1 }]);
    }
  });

  it('a Codex error message cut at 1000 chars ships no fragment either', () => {
    const line = JSON.stringify({
      timestamp: '2026-08-26T09:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'error', message: 'y'.repeat(985) + ' ' + SECRET },
    });
    const adapter = new CodexAdapter();
    // Lines before session_meta carry no session, so open one first.
    adapter.normalize(
      JSON.stringify({
        timestamp: '2026-08-26T09:00:00.000Z',
        type: 'session_meta',
        payload: { id: '019d94f1-c8eb-7582-9345-71eace2149f6', cwd: '/Users/dev/Web/api' },
      }),
      ctx,
    );
    const [error] = adapter.normalize(line, ctx);
    const { event } = applyPrivacy(error!.event, { config: config('full') });
    const serialized = JSON.stringify(event);
    for (const fragment of fragments()) expect(serialized).not.toContain(fragment);
  });

  it('leaves an ordinary title alone', () => {
    expect(deriveTitle('Add tests for the cost calculator\n\nPrice cached tokens separately.')).toBe(
      'Add tests for the cost calculator',
    );
  });

  /**
   * The same bug one rule-source over. An org's own pattern is not reachable
   * from an adapter, so the cut can only be safe if it happens after the
   * pipeline has applied the org's rules — which is why deriveTitle no longer
   * truncates at all and pipeline.ts does it instead.
   */
  it('an org-supplied pattern is not bisected either', () => {
    const orgSecret = 'ACME-PROD-' + 'Q'.repeat(32);
    const text = 'y'.repeat(100) + ' ' + orgSecret + ' tail';
    const orgRules = [{ name: 'acme', pattern: 'ACME-PROD-[A-Za-z0-9]{20,}', replacement: '[REDACTED:org_rule]' }];

    for (const mode of PRIVACY_MODES) {
      const { event } = applyPrivacy(
        {
          event_type: 'user.prompted',
          payload: { prompt_text: text, derived_title: deriveTitle(text), prompt_chars: text.length },
        } as never,
        { config: config(mode), orgRules },
      );
      const serialized = JSON.stringify(event);
      for (let i = 0; i + 12 <= orgSecret.length; i += 1) {
        expect(serialized).not.toContain(orgSecret.slice(i, i + 12));
      }
    }
  });
});
