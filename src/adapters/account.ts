import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AccountIdentity } from './types.js';
import { str } from './types.js';

/**
 * Per-account attribution.
 *
 * One machine routinely drives several accounts — a personal Claude login and
 * a work one, an OpenRouter key and an Anthropic subscription. Without an
 * account key every session on the host collapses into one identity and the
 * cost split is wrong.
 *
 * Two rules this file exists to keep:
 *
 *  1. `key` is a stable opaque id and is the only field that must travel. It is
 *     what makes sessions SPLIT per account, which has to work even in
 *     `metadata` mode. `label` and `org` name a human and their employer, so
 *     the privacy pipeline strips them below `analytics` mode.
 *  2. Credentials are never read. OpenCode's account.json carries a live
 *     `credential` next to the id, and auth.json is nothing but credentials;
 *     only `id` and `serviceID` are touched, and auth.json is never opened.
 */

/** Parsed value cached against the file's mtime — these files are re-read every scan cycle. */
const cache = new Map<string, { mtimeMs: number; size: number; value: unknown }>();

/** Test seam: forget cached identities so a rewritten file is re-read. */
export function resetAccountCache(): void {
  cache.clear();
}

/**
 * Reads and parses `path`, reusing the last result while mtime and size are
 * unchanged. Both files are re-read on every 5s scan cycle because they are
 * rewritten in place on account switch, so the cache is what keeps that free.
 */
function readCached<T>(path: string, parse: (raw: string) => T, empty: T): T {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    cache.delete(path);
    return empty; // not logged in, or the file was removed
  }

  const hit = cache.get(path);
  if (hit && hit.mtimeMs === stats.mtimeMs && hit.size === stats.size) return hit.value as T;

  let value: T;
  try {
    value = parse(readFileSync(path, 'utf8'));
  } catch {
    // A half-written or hand-mangled file must not take the collector down.
    value = empty;
  }
  cache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, value });
  return value;
}

/**
 * The Claude Code account that is active RIGHT NOW.
 *
 * ~/.claude.json holds exactly one `oauthAccount` and is rewritten when the
 * user switches accounts, so there is no history to consult: this is a
 * point-in-time reading and must be taken fresh on every scan cycle. The
 * daemon therefore attaches it only to events written while the collector was
 * running — see `Collector.liveSinceMs`.
 */
export function readClaudeAccount(claudeDir = join(homedir(), '.claude')): AccountIdentity | undefined {
  // The file sits NEXT TO the config directory: ~/.claude.json, not ~/.claude/.
  const path = join(dirname(claudeDir), '.claude.json');

  return readCached<AccountIdentity | undefined>(
    path,
    (raw) => {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return undefined;
      const oauth = (parsed as Record<string, unknown>)['oauthAccount'];
      if (!oauth || typeof oauth !== 'object') return undefined;
      const o = oauth as Record<string, unknown>;

      const key = str(o['accountUuid']);
      if (!key) return undefined; // no stable id means no attribution, not a guess
      return identity({
        key,
        label: str(o['emailAddress']) ?? str(o['displayName']),
        org: str(o['organizationName']),
        provider: 'anthropic',
        // Claude Code transcripts carry no plan signal, so cost was being
        // labelled ESTIMATED — i.e. "at API list rates" — for people paying a
        // flat subscription. This is the one place on disk that knows, and it
        // is what lets the server report SUBSCRIPTION instead.
        planType: str(o['organizationType']) ?? str(o['billingType']),
      });
    },
    undefined,
  );
}

/**
 * The OpenCode accounts that are active right now, keyed by serviceID.
 *
 * account.json is `{ accounts: { <id>: { id, serviceID, description, credential } },
 * active: { <serviceID>: <id> } }`. `credential` is a live API key and is never
 * read. One install can hold an active account per provider, so a session is
 * attributed by the provider its model actually ran on.
 */
export function readOpenCodeAccounts(dataDir: string): Map<string, AccountIdentity> {
  return readCached<Map<string, AccountIdentity>>(
    join(dataDir, 'account.json'),
    (raw) => {
      const result = new Map<string, AccountIdentity>();
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return result;

      const root = parsed as Record<string, unknown>;
      const accounts = (root['accounts'] ?? {}) as Record<string, unknown>;
      const active = (root['active'] ?? {}) as Record<string, unknown>;

      for (const [serviceID, id] of Object.entries(active)) {
        const accountId = str(id);
        if (!accountId) continue;
        const entry = accounts[accountId];
        const description =
          entry && typeof entry === 'object'
            ? str((entry as Record<string, unknown>)['description'])
            : undefined;
        result.set(
          serviceID,
          identity({
            // Neither half is a secret: serviceID is a provider name and id is
            // an opaque account id. The sibling `credential` is not read.
            key: `${serviceID}:${accountId}`,
            label: description,
            provider: serviceID,
          }),
        );
      }
      return result;
    },
    new Map(),
  );
}

/** Builds the wire shape, omitting absent optional fields rather than sending nulls. */
function identity(account: AccountIdentity): AccountIdentity {
  const out: AccountIdentity = { key: account.key };
  if (account.label) out.label = account.label;
  if (account.org) out.org = account.org;
  if (account.provider) out.provider = account.provider;
  if (account.planType) out.planType = account.planType;
  return out;
}
