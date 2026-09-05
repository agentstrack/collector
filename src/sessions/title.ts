import { redact } from '../privacy/redact.js';

/**
 * First meaningful line of a prompt, secret-redacted and NOT truncated.
 *
 * Truncation deliberately does not happen here. Cutting the line first slices a
 * straddling secret in half, neither half matches its pattern any more, and the
 * fragment ships inside the title. Only the built-in rules are reachable from an
 * adapter, so doing the cut here could only ever be safe for those — an
 * org-supplied pattern would still be bisected.
 *
 * The privacy pipeline redacts this field again with the org's own rules and
 * only then truncates it (see TITLE_MAX_LENGTH in privacy/pipeline.ts), so the
 * cut always lands on already-redacted text whatever the rule's source.
 */
export function deriveTitle(text: string): string {
  const line =
    redact(text)
      .text.split('\n')
      .map((l) => l.trim())
      // Skip markdown fences, quotes and system-reminder noise.
      .find((l) => l.length > 0 && !l.startsWith('```') && !l.startsWith('<') && !l.startsWith('>')) ?? '';
  return line.replace(/\s+/g, ' ').trim();
}
