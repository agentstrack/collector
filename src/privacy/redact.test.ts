import { describe, expect, it } from 'vitest';
import { BUILTIN_RULES, ORG_SUBJECT_CAP, commandName, compileRules, redact } from './redact.js';

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
    expect(redact(text)).toEqual({ text, redactions: [], counts: {} });
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

  it('counts how many times each rule fired, per rule name', () => {
    const a = 'ghp_' + 'a'.repeat(36);
    const b = 'ghp_' + 'b'.repeat(36);
    const out = redact(`${a} and ${b} and AKIAIOSFODNN7EXAMPLE`);
    expect(out.counts).toEqual({ github_token: 2, aws_access_key: 1 });
    expect(out.redactions).toEqual(['github_token', 'aws_access_key']);
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

  it('rejects a catastrophic-backtracking org rule but keeps a valid sibling', () => {
    const rules = compileRules([
      { pattern: '(a+)+$', replacement: 'x' }, // nested quantifier — rejected
      { pattern: 'INTERNAL-\\d+', replacement: '[TICKET]' },
      { pattern: '(a{1,})+', replacement: 'x' }, // interval inside a quantified group
      { pattern: '(a|aa)+b', replacement: 'x' }, // overlapping alternation
      { pattern: '((a+)b)+', replacement: 'x' }, // quantifier one group deeper
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.name).toBe('org_rule_1');
    expect(redact('see INTERNAL-99', rules).text).toBe('see [TICKET]');
  });

  it('reports an org rule under a generic kind, never the name the org gave it', () => {
    // The rule name can itself describe the shape of the org's secrets.
    const rules = compileRules([{ pattern: 'INTERNAL-\\d+', replacement: '[TICKET]' }]);
    const out = redact('see INTERNAL-4321 and INTERNAL-9', rules);
    expect(out.counts).toEqual({ org_rule: 2 });
    expect(out.redactions).toEqual(['org_rule']);
  });

  it('caps the subject an org rule sees so it cannot scan an unbounded input', () => {
    // A rule anchored past the cap must not match content beyond it.
    const rules = compileRules([{ pattern: 'NEEDLE', replacement: '[X]' }]);
    const hidden = 'a'.repeat(ORG_SUBJECT_CAP) + 'NEEDLE';
    expect(redact(hidden, rules).text).toContain('NEEDLE');
    // Within the cap it still fires.
    expect(redact('NEEDLE here', rules).text).toBe('[X] here');
  });
});

describe('commandName', () => {
  it('keeps the binary and drops the arguments', () => {
    expect(commandName('/usr/bin/psql --password=hunter2')).toBe('psql');
    expect(commandName('npm run build')).toBe('npm');
    expect(commandName('')).toBe('');
  });
});

describe('inline password flags', () => {
  it('redacts mysql/psql style credentials', () => {
    for (const [input, secret] of [
      ['mysql -u root -pHunter2 db', 'Hunter2'],
      ['pg_dump --password=s3cr3t mydb', 's3cr3t'],
      ['tool --password "quoted secret"', 'quoted secret'],
    ] as const) {
      expect(redact(input).text, input).not.toContain(secret);
    }
  });

  it('does not eat ordinary short flags', () => {
    // -p is also "port" or "parents"; only a value directly attached counts.
    expect(redact('mkdir -p build').text).toBe('mkdir -p build');
    expect(redact('docker run -p 8080:80 img').text).toBe('docker run -p 8080:80 img');
  });
});
