import { createHash } from 'node:crypto';

/**
 * A stable event_id from a stable seed, so re-reading a transcript (rotated
 * inode, purged spool, second collector on the same files) produces the same
 * id and the server's dedupe absorbs it instead of double-counting.
 *
 * sha256, truncated and stamped as a UUID: version nibble 8 (RFC 9562
 * "custom"), variant bits 10xx — the shape the server's `uuid()` check wants.
 */
export function deterministicEventId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
