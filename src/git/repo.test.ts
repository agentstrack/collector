import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeRepo, hashRemote, normalizeRemote, ownerAndName } from './repo.js';
import { sanitizeProjectName } from '../schema.js';

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

describe('project_name', () => {
  it('is cut to 100 characters and dropped when it carries a link, at the source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentstrack-name-'));
    try {
      const long = join(dir, 'x'.repeat(150));
      const linked = join(dir, 'www.reset-your-password.example');
      mkdirSync(long);
      mkdirSync(linked);
      expect(describeRepo(long)?.project_name).toBe('x'.repeat(100));
      expect(describeRepo(linked)?.project_name).toBeUndefined();
      expect(describeRepo(linked)?.project_path).toBe(linked);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mirrors the server transform', () => {
    expect(sanitizeProjectName('  api  ')).toBe('api');
    expect(sanitizeProjectName('agentstrack.ai')).toBe('agentstrack.ai');
    for (const hostile of ['https://x', 'evil.com/reset', 'www.evil.io', '  ']) expect(sanitizeProjectName(hostile)).toBeUndefined();
  });
});
