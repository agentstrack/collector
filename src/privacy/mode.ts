import type { PrivacyMode } from '../schema.js';

/** Least to most disclosing. */
const ORDER: Record<PrivacyMode, number> = { metadata: 0, analytics: 1, full: 2 };

/**
 * The org policy is a CEILING, never a floor.
 *
 * A developer who has chosen `metadata` locally must keep it even if their
 * organization permits `full`. Assigning the server's value outright silently
 * widens what leaves the machine, which is the one thing this tool must never
 * do — so both `login` and the daemon go through here.
 */
export function clampPrivacyMode(local: PrivacyMode, orgCeiling: string | undefined): PrivacyMode {
  // A ceiling we cannot read (missing, a newer server's mode name, a proxy's
  // garbage) is the strictest one: unknown must never loosen.
  const ceiling = isPrivacyMode(orgCeiling) ? orgCeiling : 'metadata';
  return ORDER[local] <= ORDER[ceiling] ? local : ceiling;
}

export function isPrivacyMode(value: unknown): value is PrivacyMode {
  return typeof value === 'string' && Object.hasOwn(ORDER, value);
}

export function isStricter(a: PrivacyMode, b: PrivacyMode): boolean {
  return ORDER[a] < ORDER[b];
}
