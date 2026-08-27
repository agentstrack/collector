/** First meaningful line of a prompt, trimmed to a usable title length. */
export function deriveTitle(text: string, maxLength = 120): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      // Skip markdown fences, quotes and system-reminder noise.
      .find((l) => l.length > 0 && !l.startsWith('```') && !l.startsWith('<') && !l.startsWith('>')) ?? '';
  const cleaned = line.replace(/\s+/g, ' ').trim();
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1)}…`;
}
