import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A synthetic Antigravity CLI conversation. The table definitions are agy
 * 1.2.13's own (copied from `.schema` of a real conversation); the blobs are
 * hand-encoded protobuf with the field numbers the adapter reads, and every
 * string in them is made up.
 */
const SCHEMA = `
CREATE TABLE \`trajectory_meta\` (\`trajectory_id\` text,\`cascade_id\` text,\`trajectory_type\` integer,\`source\` integer,PRIMARY KEY (\`trajectory_id\`));
CREATE TABLE \`steps\` (\`idx\` integer,\`step_type\` integer NOT NULL DEFAULT 0,\`status\` integer NOT NULL DEFAULT 0,\`has_subtrajectory\` numeric NOT NULL DEFAULT false,\`metadata\` blob,\`error_details\` blob,\`permissions\` blob,\`task_details\` blob,\`render_info\` blob,\`step_payload\` blob,\`step_format\` integer NOT NULL DEFAULT 0,PRIMARY KEY (\`idx\`));
CREATE TABLE \`gen_metadata\` (\`idx\` integer,\`data\` blob,\`size\` integer NOT NULL DEFAULT 0,PRIMARY KEY (\`idx\`));
CREATE TABLE \`trajectory_metadata_blob\` (\`id\` text DEFAULT "main",\`data\` blob,PRIMARY KEY (\`id\`));
`;

export const AGY_CONVERSATION = '0f000000-0000-4000-8000-00000000a61e';
export const AGY_T0 = Date.parse('2026-09-24T10:00:00.000Z');
export const AGY_MODEL = 'gemini-3.8-flash';
export const AGY_EMAIL = 'dev@example.com';

// --- a minimal protobuf encoder ------------------------------------------
type Value = number | string | Uint8Array | Value[];
const varint = (n: number): number[] => {
  const out: number[] = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
};
/** pb([[field, value], …]) — numbers are varints, strings/bytes/arrays length-delimited. */
export function pb(entries: [number, Value][]): Uint8Array {
  const bytes: number[] = [];
  for (const [n, value] of entries) {
    if (typeof value === 'number') {
      bytes.push(...varint((n << 3) | 0), ...varint(value));
      continue;
    }
    const body =
      typeof value === 'string'
        ? Buffer.from(value, 'utf8')
        : value instanceof Uint8Array
          ? value
          : pb(value as unknown as [number, Value][]);
    bytes.push(...varint((n << 3) | 2), ...varint(body.length), ...body);
  }
  return Uint8Array.from(bytes);
}
const ts = (ms: number) => pb([[1, Math.floor(ms / 1000)], [2, (ms % 1000) * 1e6]]);

function toolStep(at: number, ms: number, id: string, name: string, args: Record<string, unknown>) {
  return pb([
    [1, ts(at)],
    [32, ts(at)],
    [8, ts(at + ms)],
    [4, pb([[1, id], [2, name], [3, JSON.stringify({ ...args, toolAction: 'Made-up prose', toolSummary: 'More prose' })]])],
  ]);
}

/** Seeds <dir>/conversations/<id>.db and a log naming the signed-in account. */
export function seedAntigravityFixture(dir: string): string {
  mkdirSync(join(dir, 'conversations'), { recursive: true });
  mkdirSync(join(dir, 'log'), { recursive: true });
  writeFileSync(
    join(dir, 'log', 'cli-20260924_100000.log'),
    `I0924 10:00:00.000000 1 server_oauth.go:201] OAuth: authenticated successfully as ${AGY_EMAIL}\n`,
  );
  const path = join(dir, 'conversations', `${AGY_CONVERSATION}.db`);
  const db = new Database(path);
  db.exec(SCHEMA);
  db.prepare("INSERT INTO trajectory_meta VALUES ('t1', ?, 4, 17)").run(AGY_CONVERSATION);
  db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(
    pb([[1, [[1, 'file:///work/agy-project'], [4, 'feature/x']]], [2, ts(AGY_T0)], [18, 'default-cli-project']]),
  );
  db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (0, ?)').run(pb([[1, [[19, AGY_MODEL], [4, [[7, 'bot-1']]]]]]));

  const step = db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)');
  step.run(0, 14, 3, pb([[1, ts(AGY_T0)]]), pb([[1, 14], [19, [[2, 'Synthetic prompt: add a flag']]]]));
  step.run(
    1, 15, 3,
    pb([[1, ts(AGY_T0 + 1000)], [8, ts(AGY_T0 + 3000)], [9, [[2, 1000], [3, 300], [5, 500], [9, 200], [10, 100], [7, 'bot-1']]]]),
    null,
  );
  step.run(2, 132, 3, toolStep(AGY_T0 + 4000, 1500, 'call_1', 'run_command', { CommandLine: 'npm test', Cwd: '/work/agy-project' }), null);
  step.run(
    3, 132, 7,
    toolStep(AGY_T0 + 6000, 200, 'call_2', 'replace_file_content', {
      TargetFile: '/work/agy-project/src/a.ts', TargetContent: 'a\nb', ReplacementContent: 'a\nc\nd',
    }),
    null,
  );
  step.run(4, 132, 2, toolStep(AGY_T0 + 7000, 0, 'call_3', 'view_file', { AbsolutePath: '/work/agy-project/src/b.ts' }), null);
  step.run(5, 132, 3, toolStep(AGY_T0 + 8000, 50, 'call_4', 'view_file', { AbsolutePath: '/work/agy-project/src/c.ts' }), null);
  db.close();
  return path;
}
