import { describe, expect, it } from 'vitest';
import { clampPrivacyMode } from './mode.js';

describe('clampPrivacyMode — org policy is a ceiling, not a floor', () => {
  it('keeps a stricter local choice even when the org allows more', () => {
    // Regression: `login` used to assign the server's mode outright, silently
    // widening a developer who had deliberately chosen metadata.
    expect(clampPrivacyMode('metadata', 'full')).toBe('metadata');
    expect(clampPrivacyMode('metadata', 'analytics')).toBe('metadata');
    expect(clampPrivacyMode('analytics', 'full')).toBe('analytics');
  });

  it('lowers a looser local choice down to the org ceiling', () => {
    expect(clampPrivacyMode('full', 'metadata')).toBe('metadata');
    expect(clampPrivacyMode('full', 'analytics')).toBe('analytics');
    expect(clampPrivacyMode('analytics', 'metadata')).toBe('metadata');
  });

  it('is a no-op when they agree', () => {
    for (const mode of ['metadata', 'analytics', 'full'] as const) {
      expect(clampPrivacyMode(mode, mode)).toBe(mode);
    }
  });

  it('never returns a mode looser than either input', () => {
    const order = { metadata: 0, analytics: 1, full: 2 } as const;
    const modes = ['metadata', 'analytics', 'full'] as const;
    for (const local of modes) {
      for (const org of modes) {
        const result = clampPrivacyMode(local, org);
        expect(order[result]).toBeLessThanOrEqual(Math.min(order[local], order[org]));
      }
    }
  });
});
