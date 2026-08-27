import { describe, expect, it } from 'vitest';
import { BUILTIN_RULES, commandName, compileRules, redact } from './redact.js';

describe('secret redaction', () => {
  it('redacts real-shaped provider credentials', () => {
    const cases: [string, string][] = [
      ['sk-ant-api03-' + 'a'.repeat(40), 'anthropic_key'],
      ['sk-proj-' + 'b'.repeat(40), 'openai_key'],
      ['ghp_' + 'c'.repeat(36), 'github_token'],
      ['xoxb-1234567890-abcdefghij', 'slack_token'],
      ['sk_live_' + 'd'.repeat(24), 'stripe_key'],
      ['AKIAIOSFODNN7EXAMPLE', 'aws_access_key'],
      ['at_live_' + 'a'.repeat(16) + '_' + 'z'.repeat(30), 'agentstrack_key'],
    ];
    for (const [secret, rule] of cases) {
      const out = redact(`here is my key ${secret} ok`);
      expect(out.text, `${rule} should be redacted`).not.toContain(secret);
      expect(out.redactions).toContain(rule);
    }
  });

  it('redacts credentials embedded in a URL', () => {
    const out = redact('git clone https://user:hunter2@github.com/acme/api.git');
    expect(out.text).not.toContain('hunter2');
    expect(out.text).toContain('[REDACTED]@github.com');
  });

  it('redacts secret-looking environment assignments', () => {
    const out = redact('export DATABASE_PASSWORD=s3cr3tvalue && echo done');
    expect(out.text).not.toContain('s3cr3tvalue');
    expect(out.text).toContain('DATABASE_PASSWORD=[REDACTED]');
  });

  it('redacts a private key block entirely', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc123\n-----END RSA PRIVATE KEY-----';
    const out = redact(`config:\n${key}\ndone`);
    expect(out.text).not.toContain('MIIEabc123');
    expect(out.text).toContain('[REDACTED:private_key]');
  });

  it('leaves ordinary prose untouched', () => {
    const text = 'Refactor the auth guard and add tests for the cost calculator';
    expect(redact(text)).toEqual({ text, redactions: [] });
  });

  it('is not stateful across calls — global regexes must not skip matches', () => {
    const secret = 'ghp_' + 'e'.repeat(36);
    for (let i = 0; i < 5; i++) {
      expect(redact(`token ${secret}`).text, `call ${i}`).not.toContain(secret);
    }
  });

  it('redacts every occurrence, not just the first', () => {
    const a = 'ghp_' + 'a'.repeat(36);
    const b = 'ghp_' + 'b'.repeat(36);
    const out = redact(`${a} and ${b}`);
    expect(out.text).not.toContain(a);
    expect(out.text).not.toContain(b);
  });

  it('has no rule with a catastrophic-looking nested quantifier', () => {
    for (const rule of BUILTIN_RULES) {
      expect(rule.pattern.source, rule.name).not.toMatch(/\([^)]*[+*]\)[+*]/);
    }
  });
});

describe('compileRules', () => {
  it('applies valid org rules and skips invalid ones without throwing', () => {
    const rules = compileRules([
      { pattern: 'INTERNAL-\\d+', replacement: '[TICKET]' },
      { pattern: '([unclosed', replacement: 'x' },
    ]);
    expect(rules).toHaveLength(1);
    expect(redact('see INTERNAL-4321', rules).text).toBe('see [TICKET]');
  });
});

describe('commandName', () => {
  it('keeps the binary and drops the arguments', () => {
    expect(commandName('/usr/bin/psql --password=hunter2')).toBe('psql');
    expect(commandName('npm run build')).toBe('npm');
    expect(commandName('')).toBe('');
  });
});
