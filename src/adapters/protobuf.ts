/**
 * Just enough protobuf wire-format reading to pull numbered fields out of a
 * blob, with no schema and no dependency.
 *
 * Antigravity stores its steps as serialized protobuf. Field numbers were read
 * off the descriptors embedded in the `agy` binary (see antigravity.ts); this
 * only walks the wire format. Anything malformed yields "field absent", never a
 * throw — an agent update that reshapes a message must degrade to fewer events.
 */
export type Field = { n: number; varint?: bigint; bytes?: Uint8Array };

export function fields(buf: Uint8Array | null | undefined): Field[] {
  if (!buf) return [];
  const out: Field[] = [];
  let i = 0;
  const varint = (): bigint => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (i >= buf.length) throw new RangeError('truncated varint');
      const byte = buf[i++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw new RangeError('varint too long');
  };
  try {
    while (i < buf.length) {
      const key = Number(varint());
      const n = key >>> 3;
      const wire = key & 7;
      if (n === 0) break;
      if (wire === 0) out.push({ n, varint: varint() });
      else if (wire === 2) {
        const len = Number(varint());
        if (i + len > buf.length) break;
        out.push({ n, bytes: buf.subarray(i, i + len) });
        i += len;
      } else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else break; // groups are long dead; stop rather than guess
    }
  } catch {
    // Truncated blob: keep what parsed cleanly.
  }
  return out;
}

/** The first length-delimited field `n` (a sub-message or string), following a path of field numbers. */
export function msg(buf: Uint8Array | null | undefined, ...path: number[]): Uint8Array | undefined {
  let current: Uint8Array | undefined = buf ?? undefined;
  for (const n of path) {
    current = fields(current).find((f) => f.n === n && f.bytes)?.bytes;
    if (!current) return undefined;
  }
  return current;
}

export function text(buf: Uint8Array | null | undefined, ...path: number[]): string | undefined {
  const bytes = msg(buf, ...path);
  return bytes && bytes.length > 0 ? Buffer.from(bytes).toString('utf8') : undefined;
}

export function int(buf: Uint8Array | null | undefined, n: number): number {
  const value = fields(buf).find((f) => f.n === n && f.varint !== undefined)?.varint;
  return value === undefined ? 0 : Number(value);
}

/** google.protobuf.Timestamp at field `n`, as epoch ms (0 when absent). */
export function timestampMs(buf: Uint8Array | null | undefined, n: number): number {
  const ts = msg(buf, n);
  if (!ts) return 0;
  return int(ts, 1) * 1000 + Math.floor(int(ts, 2) / 1e6);
}
