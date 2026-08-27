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
export function clampPrivacyMode(local: PrivacyMode, orgCeiling: PrivacyMode): PrivacyMode {
  return ORDER[local] <= ORDER[orgCeiling] ? local : orgCeiling;
}

export function isStricter(a: PrivacyMode, b: PrivacyMode): boolean {
  return ORDER[a] < ORDER[b];
}
