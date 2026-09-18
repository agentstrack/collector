import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '../schema.js';

export interface Checkpoint {
  inode: string;
  offset: number;
  size: number;
}

/**
 * Durable local spool.
 *
 * Everything the collector observes lands here first and is only deleted once
 * the server has acknowledged it. That is what makes the collector survive
 * being offline, killed mid-flight, or pointed at an API that is down — a
 * developer's day of work is never lost to a network blip.
 *
 * Also stores per-file read offsets so a restart resumes mid-file instead of
 * re-uploading or skipping.
 */
export class Spool {
  private readonly db: Database.Database;
  private readonly stmt: {
    insert: Database.Statement;
    peek: Database.Statement;
    del: Database.Statement;
    bump: Database.Statement;
    drop: Database.Statement;
    count: Database.Statement;
    checkpoint: Database.Statement;
    getMeta: Database.Statement;
    setMeta: Database.Statement;
    delMeta: Database.Statement;
  };
  /**
   * Every checkpoint, in memory. A steady-state scan touches every tracked
   * file every 5s and almost none of them changed; answering that from a Map
   * costs nothing, and only a change is written through.
   */
  private readonly checkpoints = new Map<string, Checkpoint>();

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    // WAL so a crash mid-write cannot corrupt the queue.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    // The WAL is otherwise only trimmed on close; a backfill leaves it at its
    // high-water mark forever.
    this.db.pragma('journal_size_limit = 8388608');
    // The spool holds un-uploaded telemetry; default umask makes it
    // world-readable. WAL and SHM exist only after the pragma above.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        chmodSync(`${path}${suffix}`, 0o600);
      } catch {
        // The main db is the one that matters.
      }
    }
    this.migrate();
    this.vacuumIfBloated();

    this.stmt = {
      insert: this.db.prepare('INSERT OR IGNORE INTO events (event_id, body, created_at) VALUES (?, ?, ?)'),
      peek: this.db.prepare('SELECT event_id, body FROM events ORDER BY created_at ASC, rowid ASC LIMIT ?'),
      del: this.db.prepare('DELETE FROM events WHERE event_id = ?'),
      bump: this.db.prepare('UPDATE events SET attempts = attempts + 1 WHERE event_id = ?'),
      drop: this.db.prepare('DELETE FROM events WHERE event_id = ? AND attempts >= ?'),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM events'),
      checkpoint: this.db.prepare(
        `INSERT INTO checkpoints (path, inode, offset, size) VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET inode = excluded.inode, offset = excluded.offset, size = excluded.size`,
      ),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ),
      delMeta: this.db.prepare('DELETE FROM meta WHERE key = ?'),
    };

    this.loadCheckpoints();
  }

  private loadCheckpoints(): void {
    const rows = this.db.prepare('SELECT path, inode, offset, size FROM checkpoints').all() as (Checkpoint & {
      path: string;
    })[];
    this.checkpoints.clear();
    for (const { path: p, ...cp } of rows) this.checkpoints.set(p, cp);
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id   TEXT PRIMARY KEY,
        body       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

      CREATE TABLE IF NOT EXISTS checkpoints (
        path   TEXT PRIMARY KEY,
        inode  TEXT NOT NULL,
        offset INTEGER NOT NULL,
        size   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /**
   * A drained backfill leaves the file at its high-water mark, nearly all of
   * it free pages (a 206MB spool holding 78 events was observed). VACUUM once
   * at open when the freelist is both large and the majority of the file —
   * never on a small db, where it is pure cost.
   */
  private vacuumIfBloated() {
    const free = Number(this.db.pragma('freelist_count', { simple: true }));
    const pages = Number(this.db.pragma('page_count', { simple: true }));
    if (free > 2048 && free > pages / 2) {
      try {
        this.db.exec('VACUUM');
      } catch {
        // Out of disk or a concurrent reader: the queue still works, just fat.
      }
    }
  }

  /** Runs `fn` atomically. A throw rolls back everything written inside it. */
  transaction<T>(fn: () => T): T {
    try {
      return this.db.transaction(fn)();
    } catch (error) {
      // setCheckpoint() updated the cache before the rollback (or a failed
      // COMMIT — SQLITE_FULL) undid the row; bring it back in line with disk.
      this.loadCheckpoints();
      throw error;
    }
  }

  enqueue(events: EventEnvelope[]): number {
    if (events.length === 0) return 0;
    const now = Date.now();
    return this.transaction(() => {
      let written = 0;
      for (const event of events) written += this.stmt.insert.run(event.event_id, JSON.stringify(event), now).changes;
      return written;
    });
  }

  /** Oldest-first so a backlog drains in the order it happened. */
  peek(limit: number): { eventId: string; event: EventEnvelope }[] {
    const rows = this.stmt.peek.all(limit) as { event_id: string; body: string }[];

    return rows.flatMap((row) => {
      try {
        return [{ eventId: row.event_id, event: JSON.parse(row.body) as EventEnvelope }];
      } catch {
        // Unparseable row would block the queue forever; drop it.
        this.ack([row.event_id]);
        return [];
      }
    });
  }

  ack(eventIds: string[]): void {
    if (eventIds.length === 0) return;
    this.transaction(() => eventIds.forEach((id) => this.stmt.del.run(id)));
  }

  /**
   * Records a failed attempt so poison events can be dropped eventually.
   *
   * Two things this must not do, both of which it used to:
   *  - delete across the whole table. Only the events in THIS batch have just
   *    failed; an untouched event elsewhere in the spool is not poison.
   *  - honour maxAttempts <= 0. `attempts >= 0` matches every row including
   *    never-attempted ones, so a config of 0 wiped the entire queue on the
   *    first network blip. At least one attempt must always be allowed.
   */
  fail(eventIds: string[], maxAttempts: number): number {
    if (eventIds.length === 0) return 0;
    const limit = Math.max(1, maxAttempts);

    return this.transaction(() => {
      let dropped = 0;
      for (const id of eventIds) {
        this.stmt.bump.run(id);
        dropped += this.stmt.drop.run(id, limit).changes;
      }
      return dropped;
    });
  }

  depth(): number {
    return (this.stmt.count.get() as { n: number }).n;
  }

  getCheckpoint(path: string): Checkpoint | null {
    return this.checkpoints.get(path) ?? null;
  }

  setCheckpoint(path: string, inode: string, offset: number, size: number): void {
    const current = this.checkpoints.get(path);
    if (current && current.inode === inode && current.offset === offset && current.size === size) return;
    this.stmt.checkpoint.run(path, inode, offset, size);
    this.checkpoints.set(path, { inode, offset, size });
  }

  /**
   * Forget every read checkpoint, so the next scan re-reads each transcript
   * from byte 0.
   *
   * Safe to do because an event id is derived from
   * `(adapter, file, offset, line)` and is the server's primary key: a
   * re-read reproduces the same ids, and the server counts them as
   * `duplicates` rather than writing them twice. That is what makes
   * reconciliation a re-read instead of a diff — and why this must never be
   * paired with a change to the id seed.
   *
   * The spooled queue is deliberately left alone. Events already waiting are
   * still owed to the server; dropping them here would turn a reconcile into
   * data loss in the one case it exists to repair.
   */
  clearCheckpoints(): number {
    const { changes } = this.db.prepare('DELETE FROM checkpoints').run();
    this.checkpoints.clear();
    return changes;
  }

  getMeta(key: string): string | null {
    return (this.stmt.getMeta.get(key) as { value: string } | undefined)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.stmt.setMeta.run(key, value);
  }

  deleteMeta(key: string): void {
    this.stmt.delMeta.run(key);
  }

  /** Stable per-install id, generated once. */
  installId(): string {
    let id = this.getMeta('install_id');
    if (!id) {
      id = randomUUID();
      this.setMeta('install_id', id);
    }
    return id;
  }

  close(): void {
    this.db.close();
  }
}
