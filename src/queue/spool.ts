import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '../schema.js';

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

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    // The spool holds un-uploaded telemetry; default umask makes it world-readable.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        chmodSync(`${path}${suffix}`, 0o600);
      } catch {
        // WAL/SHM may not exist yet; the main db is the one that matters.
      }
    }
    // WAL so a crash mid-write cannot corrupt the queue.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
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

  enqueue(events: EventEnvelope[]): number {
    if (events.length === 0) return 0;
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO events (event_id, body, created_at) VALUES (?, ?, ?)',
    );
    const now = Date.now();
    const insertAll = this.db.transaction((batch: EventEnvelope[]) => {
      let written = 0;
      for (const event of batch) written += stmt.run(event.event_id, JSON.stringify(event), now).changes;
      return written;
    });
    return insertAll(events);
  }

  /** Oldest-first so a backlog drains in the order it happened. */
  peek(limit: number): { eventId: string; event: EventEnvelope }[] {
    const rows = this.db
      .prepare('SELECT event_id, body FROM events ORDER BY created_at ASC, rowid ASC LIMIT ?')
      .all(limit) as { event_id: string; body: string }[];

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
    const stmt = this.db.prepare('DELETE FROM events WHERE event_id = ?');
    this.db.transaction((ids: string[]) => ids.forEach((id) => stmt.run(id)))(eventIds);
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

    const bump = this.db.prepare('UPDATE events SET attempts = attempts + 1 WHERE event_id = ?');
    const drop = this.db.prepare('DELETE FROM events WHERE event_id = ? AND attempts >= ?');

    return this.db.transaction((ids: string[]) => {
      let dropped = 0;
      for (const id of ids) {
        bump.run(id);
        dropped += drop.run(id, limit).changes;
      }
      return dropped;
    })(eventIds);
  }

  depth(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  }

  getCheckpoint(path: string): { inode: string; offset: number; size: number } | null {
    return (
      (this.db.prepare('SELECT inode, offset, size FROM checkpoints WHERE path = ?').get(path) as
        | { inode: string; offset: number; size: number }
        | undefined) ?? null
    );
  }

  setCheckpoint(path: string, inode: string, offset: number, size: number): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints (path, inode, offset, size) VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET inode = excluded.inode, offset = excluded.offset, size = excluded.size`,
      )
      .run(path, inode, offset, size);
  }

  getMeta(key: string): string | null {
    return (
      (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ??
      null
    );
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
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
