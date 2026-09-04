import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A miniature copy of OpenCode 1.18's real schema — the column list is what
 * the adapter's SQL is written against, so a drift here is a drift there.
 */
const SCHEMA = `
CREATE TABLE session (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
  directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT,
  summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  time_compacting INTEGER, time_archived INTEGER,
  workspace_id TEXT, path TEXT, agent TEXT, model TEXT,
  cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL,
  tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
  tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
  metadata TEXT
);
CREATE TABLE message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE TABLE part (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
`;

export const T0 = Date.now() - 3600_000;
export const MODEL = '{"id":"deepseek/deepseek-v4-pro","providerID":"openrouter","variant":"default"}';

const INSERT_SESSION = `INSERT INTO session (id, project_id, slug, directory, title, version, agent, model, cost,
       tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
       time_created, time_updated, time_archived)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/** Writes `opencode.db` and `account.json` into `dir`: one archived session with a prompt and four tool parts. */
export function seedOpenCodeFixture(dir: string): void {
  const db = new Database(join(dir, 'opencode.db'));
  db.exec(SCHEMA);
  db.prepare(INSERT_SESSION).run(
    'ses_a', 'prj', 'slug', '/Users/dev/proj', 'Fix the cost calculator', '1.18.21', 'build',
    MODEL, 1.2345, 100965, 25243, 13765, 16120260, 264711, T0, T0 + 60_000, T0 + 60_000,
  );
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)').run(
    'msg_u', 'ses_a', T0 + 1000, T0 + 1000, JSON.stringify({ role: 'user' }),
  );
  const part = db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)',
  );
  part.run('prt_t', 'msg_u', 'ses_a', T0 + 1000, T0 + 1000, JSON.stringify({ type: 'text', text: 'fix the cost calculator please' }));
  part.run('prt_bash', 'msg_u', 'ses_a', T0 + 2000, T0 + 2000, JSON.stringify({
    type: 'tool', tool: 'bash', callID: 'call_1',
    state: { status: 'completed', input: { command: 'pnpm test' }, output: 'SECRET OUTPUT', time: { start: T0 + 2000, end: T0 + 2500 } },
  }));
  part.run('prt_edit', 'msg_u', 'ses_a', T0 + 3000, T0 + 3000, JSON.stringify({
    type: 'tool', tool: 'edit', callID: 'call_2',
    state: { status: 'completed', time: { start: T0 + 3000, end: T0 + 3100 },
      input: { filePath: '/Users/dev/proj/a.ts', oldString: 'a\nb', newString: 'a\nc\nd' } },
  }));
  part.run('prt_fail', 'msg_u', 'ses_a', T0 + 4000, T0 + 4000, JSON.stringify({
    type: 'tool', tool: 'grep', callID: 'call_3', state: { status: 'error', time: { start: T0 + 4000, end: T0 + 4001 } },
  }));
  part.run('prt_running', 'msg_u', 'ses_a', T0 + 5000, T0 + 5000, JSON.stringify({
    type: 'tool', tool: 'bash', callID: 'call_4', state: { status: 'running', input: { command: 'sleep 9' } },
  }));
  db.close();

  writeFileSync(
    join(dir, 'account.json'),
    JSON.stringify({
      version: 2,
      accounts: { acc1: { id: 'acc1', serviceID: 'openrouter', description: 'default', credential: 'sk-live-DO-NOT-READ' } },
      active: { openrouter: 'acc1' },
    }),
  );
}

/** A session created a day before `ses_a` but touched after it — the resumed-session shape. */
export function addResumedSession(dir: string, touchedAt: number): void {
  const db = new Database(join(dir, 'opencode.db'));
  db.prepare(INSERT_SESSION).run(
    'ses_old', 'prj', 'slug2', '/Users/dev/proj', 'Yesterday', '1.18.21', 'build',
    MODEL, 0, 10, 5, 0, 0, 0, T0 - 86_400_000, touchedAt, null,
  );
  db.close();
}
