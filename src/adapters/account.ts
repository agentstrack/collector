import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  // The default install keeps it NEXT TO the config directory (~/.claude.json),
  // but a CLAUDE_CONFIG_DIR profile keeps its own login INSIDE the directory —
  // reading the sibling there would hand every profile the default login.
  const inside = join(claudeDir, '.claude.json');
  const path = existsSync(inside) ? inside : join(dirname(claudeDir), '.claude.json');

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
 * Which config directory each running Claude Code session was started under.
 *
 * One machine can run several logins at once — CLAUDE_CONFIG_DIR per profile —
 * while every profile writes into the same projects/ folder (a symlink), so
 * neither the transcript nor its path says whose session it is. What does:
 * every live process writes <config>/sessions/<pid>.json with its sessionId,
 * and the process's own environment carries the CLAUDE_CONFIG_DIR it was
 * launched with. No CLAUDE_CONFIG_DIR means the default directory.
 *
 * A pid file whose process is gone, or whose pid now belongs to a process
 * started after the session, is skipped: a stale file must not attribute.
 */
export function readClaudeLiveSessions(
  sessionsDir: string,
  defaultDir = join(homedir(), '.claude'),
): { sessionId: string; configDir: string }[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const files = names.flatMap((name) => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(sessionsDir, name), 'utf8'));
      if (!parsed || typeof parsed !== 'object') return [];
      const o = parsed as Record<string, unknown>;
      const pid = o['pid'];
      const sessionId = str(o['sessionId']);
      if (typeof pid !== 'number' || !sessionId) return [];
      const startedAt = typeof o['startedAt'] === 'number' ? o['startedAt'] : undefined;
      return [{ pid, sessionId, startedAt }];
    } catch {
      return []; // half-written: next cycle
    }
  });
  if (files.length === 0) return [];

  const envs = processEnvs(files.map((f) => f.pid));
  return files.flatMap((f) => {
    const proc = envs.get(f.pid);
    if (!proc) return [];
    // pid reuse: a process that started well after the session is not its owner.
    if (proc.startedMs !== undefined && f.startedAt !== undefined && proc.startedMs > f.startedAt + 60_000) return [];
    return [{ sessionId: f.sessionId, configDir: resolve(proc.configDir ?? defaultDir) }];
  });
}

/** CLAUDE_CONFIG_DIR (and start time, where cheap) of each live pid. Absent pid = not running. */
function processEnvs(pids: number[]): Map<number, { configDir?: string; startedMs?: number }> {
  const out = new Map<number, { configDir?: string; startedMs?: number }>();
  if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
        const hit = env.find((e) => e.startsWith('CLAUDE_CONFIG_DIR='));
        out.set(pid, hit ? { configDir: hit.slice('CLAUDE_CONFIG_DIR='.length) } : {});
      } catch {
        // gone, or not ours
      }
    }
    return out;
  }
  if (process.platform !== 'darwin') return out; // ponytail: no env access elsewhere; add Windows when someone runs profiles there

  // ps rejects the whole call on a pid above kern.maxpid (99998), and a pid
  // file can hold any number; one bad file must not hide every live session.
  const valid = pids.filter((pid) => Number.isInteger(pid) && pid > 0 && pid <= 99_998);
  if (valid.length === 0) return out;

  let stdout: string;
  try {
    // -E appends the process's initial environment to the command column.
    stdout = execFileSync('ps', ['-wwE', '-o', 'pid=,lstart=,command=', '-p', valid.join(',')], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    // ps exits 1 when any pid is gone but still prints the live ones.
    stdout = String((error as { stdout?: unknown }).stdout ?? '');
  }
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\w{3} \w{3}\s+\d+ \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    // ponytail: a CLAUDE_CONFIG_DIR containing a space is cut at the space; /proc-style parsing needs a native call on macOS.
    const dir = /(?:^|\s)CLAUDE_CONFIG_DIR=(\S+)/.exec(m[3]!)?.[1];
    const started = Date.parse(m[2]!); // lstart is local time, as Date.parse reads it
    out.set(Number(m[1]), {
      ...(dir ? { configDir: dir } : {}),
      ...(Number.isFinite(started) ? { startedMs: started } : {}),
    });
  }
  return out;
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
