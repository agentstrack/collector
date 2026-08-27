import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeAccount, readOpenCodeAccounts, resetAccountCache } from './account.js';
import { attributable } from '../daemon.js';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentstrack-account-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetAccountCache();
});

describe('readClaudeAccount', () => {
  const write = (home: string, oauth: unknown) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: oauth, projects: {} }));
    return join(home, '.claude');
  };

  it('maps oauthAccount onto the wire contract', () => {
    const claudeDir = write(scratch(), {
      accountUuid: '11111111-2222-4333-8444-555555555555',
      emailAddress: 'ada@acme.dev',
      organizationName: 'Acme Inc',
      displayName: 'Ada',
      billingType: 'subscription',
    });
    expect(readClaudeAccount(claudeDir)).toEqual({
      key: '11111111-2222-4333-8444-555555555555',
      label: 'ada@acme.dev',
      org: 'Acme Inc',
      provider: 'anthropic',
      // Carried so a flat-rate subscriber's cost is labelled SUBSCRIPTION
      // rather than "estimated at API list rates".
      planType: 'subscription',
    });
  });

  it('re-reads after an account switch rather than serving the cached identity', () => {
    const home = scratch();
    const claudeDir = write(home, { accountUuid: 'first', emailAddress: 'a@x.dev' });
    expect(readClaudeAccount(claudeDir)?.key).toBe('first');

    // ~/.claude.json is REWRITTEN on switch — caching by content would pin the
    // collector to whoever was signed in when it booted.
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid: 'second', emailAddress: 'b@x.dev' } }),
    );
    expect(readClaudeAccount(claudeDir)?.key).toBe('second');
  });

  it('returns nothing rather than guessing when logged out or malformed', () => {
    expect(readClaudeAccount(join(scratch(), '.claude'))).toBeUndefined();

    const home = scratch();
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude.json'), '{ half-written');
    expect(readClaudeAccount(join(home, '.claude'))).toBeUndefined();

    // No accountUuid means no stable identity; a display name is not one.
    const other = scratch();
    writeFileSync(join(other, '.claude.json'), JSON.stringify({ oauthAccount: { displayName: 'Ada' } }));
    expect(readClaudeAccount(join(other, '.claude'))).toBeUndefined();
  });
});

describe('readOpenCodeAccounts', () => {
  it('derives serviceID:id per active provider and never touches the credential', () => {
    const dir = scratch();
    writeFileSync(
      join(dir, 'account.json'),
      JSON.stringify({
        version: 2,
        accounts: {
          a1: { id: 'a1', serviceID: 'openrouter', description: 'default', credential: 'sk-live-SECRET' },
          a2: { id: 'a2', serviceID: 'anthropic', description: 'work', credential: 'sk-ant-SECRET' },
        },
        active: { openrouter: 'a1', anthropic: 'a2' },
      }),
    );
    const accounts = readOpenCodeAccounts(dir);
    expect(accounts.get('openrouter')).toEqual({ key: 'openrouter:a1', label: 'default', provider: 'openrouter' });
    expect(accounts.get('anthropic')).toEqual({ key: 'anthropic:a2', label: 'work', provider: 'anthropic' });
    expect(JSON.stringify([...accounts])).not.toContain('SECRET');
  });

  it('is empty when OpenCode has never been logged in', () => {
    expect(readOpenCodeAccounts(scratch()).size).toBe(0);
  });
});

describe('attributable — live events only', () => {
  const liveSince = Date.parse('2026-08-27T10:00:00.000Z');
  const at = (iso: string) => attributable('user.prompted', iso, liveSince);

  it('attributes what was written while the collector was watching', () => {
    expect(at('2026-08-27T10:00:00.000Z')).toBe(true);
    expect(at('2026-08-27T11:00:00.000Z')).toBe(true);
  });

  it('refuses to attribute a backfilled transcript to today’s account', () => {
    expect(at('2026-08-26T09:00:00.000Z')).toBe(false);
    expect(at('not a date')).toBe(false);
  });

  it('only session.started and user.prompted carry the account', () => {
    const now = '2026-08-27T12:00:00.000Z';
    expect(attributable('session.started', now, liveSince)).toBe(true);
    expect(attributable('usage.reported', now, liveSince)).toBe(false);
    expect(attributable('tool.completed', now, liveSince)).toBe(false);
  });
});

describe('plan type drives cost basis', () => {
  it('carries the Claude plan tier so a subscriber is not billed at API rates', () => {
    // ~/.claude.json is the only place on disk that knows the plan. Without it
    // a flat-rate subscriber's spend reads as "estimated at API list rates",
    // which looks like a bill they never received.
    const dir = mkdtempSync(join(tmpdir(), 'acct-'));
    writeFileSync(
      join(dir, '.claude.json'),
      JSON.stringify({
        oauthAccount: {
          accountUuid: '6e1fc546-c8b5-4670-a3d4-cdb793a24088',
          emailAddress: 'dev@example.com',
          organizationName: 'Example Org',
          organizationType: 'claude_max',
          billingType: 'stripe_subscription',
        },
      }),
    );
    resetAccountCache();
    // readClaudeAccount takes the .claude DIRECTORY; the file is its sibling.
    const account = readClaudeAccount(join(dir, '.claude'));
    expect(account?.planType).toBe('claude_max');
    rmSync(dir, { recursive: true, force: true });
  });
});
