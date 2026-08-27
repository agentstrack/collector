import { describe, expect, it } from 'vitest';
import { hashRemote, normalizeRemote, ownerAndName } from './repo.js';

describe('remote normalization', () => {
  it('collapses every clone form of one repo onto a single identity', () => {
    const forms = [
      'git@github.com:acme/api.git',
      'https://github.com/acme/api.git',
      'https://github.com/acme/api',
      'ssh://git@github.com/acme/api.git',
      'git@github.com:acme/api',
    ];
    expect(new Set(forms.map(hashRemote)).size).toBe(1);
    expect(normalizeRemote(forms[0]!)).toBe('github.com/acme/api');
  });

  it('keeps different repositories distinct', () => {
    expect(hashRemote('git@github.com:acme/api')).not.toBe(hashRemote('git@github.com:acme/web'));
    expect(hashRemote('git@github.com:acme/api')).not.toBe(hashRemote('git@gitlab.com:acme/api'));
  });

  it('never returns the URL itself — the hash must not contain it', () => {
    const remote = 'https://github.com/secret-client/private-repo';
    const hash = hashRemote(remote);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain('secret-client');
  });

  it('extracts owner and name for display', () => {
    expect(ownerAndName('git@github.com:acme/api.git')).toEqual({ owner: 'acme', name: 'api' });
  });

  it('does not throw on a malformed remote', () => {
    expect(() => hashRemote('this is not a url')).not.toThrow();
    expect(ownerAndName('nonsense')).toEqual({});
  });
});
