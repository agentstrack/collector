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

  it('leaves -p flags of commands that have no password option alone', () => {
    // Every one of these fired the rule before it was anchored, and each one
    // mailed an owner "rotate an exposed credential" over a `find` flag.
    for (const cmd of [
      'find . -not -path "*/node_modules/*"',
      'find . -name "*.ts" -print',
      'find . -type d -prune',
      'tar -pxzf archive.tgz',
      'ssh -p2222 host',
      'grep -perl foo .',
    ]) {
      expect(redact(cmd).text, cmd).toBe(cmd);
      expect(redact(cmd).redactions, cmd).toEqual([]);
    }
  });

  it('still catches the short form on commands that do take a password', () => {
    for (const [input, secret] of [
      ['mysql -u root -pHunter2 db', 'Hunter2'],
      ['mysqldump -uroot -pHunter2 db > out.sql', 'Hunter2'],
      ['sshpass -pHunter2 ssh host', 'Hunter2'],
      ['docker build . && mysql -pHunter2', 'Hunter2'],
    ] as const) {
      expect(redact(input).text, input).not.toContain(secret);
      expect(redact(input).redactions, input).toContain('inline_password_flag');
    }
  });
});

describe('commandName — wrappers and leading assignments', () => {
  it('skips NAME=value tokens, wrapper commands and their flags', () => {
    expect(commandName('API_TOKEN=abc npm test')).toBe('npm');
    expect(commandName('FOO=x /Users/x/bin/deploy')).toBe('deploy');
    expect(commandName('  ls')).toBe('ls');
    expect(commandName('sudo -E env -i PATH=/bin nohup time /usr/bin/make all')).toBe('make');
    expect(commandName('A=1 B=2')).toBe('');
    expect(commandName('   ')).toBe('');
  });
});

describe('broader secret patterns', () => {
  const cases: [string, string][] = [
    ['npm_token', `//registry.npmjs.org/:_authToken npm_${'a1B2'.repeat(9)}`],
    ['gitlab_token', `glpat-${'x'.repeat(20)}`],
    ['huggingface_token', `hf_${'Ab3'.repeat(12)}`],
    ['sendgrid_key', `SG.${'a'.repeat(22)}.${'b'.repeat(43)}`],
    ['google_oauth_token', `ya29.${'a0Ab'.repeat(10)}`],
    ['basic_auth_header', 'curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA=="'],
    ['secret_assignment', "curl -H 'X-Api-Key: k3y-v4lue-123'"],
    ['secret_assignment', 'db_password=hunter2'],
    ['secret_assignment', 'aws_secret_access_key = wJalrXUtnFEMIK7MDENG'],
    ['secret_assignment', 'GET /cb?access_token=abc123&state=1'],
    ['secret_assignment', '{"password":"hunter2","user":"x"}'],
    ['secret_assignment', '{"apiKey": "k-123456"}'],
    ['secret_assignment', 'clientSecret: s3cr3tvalue'],
    ['secret_assignment', 'DB_PASS=hunter2'],
    ['secret_assignment', 'https://x.example/login?user=a&pass=hunter2'],
    ['secret_assignment', '{"auth":"hunter2"}'],
    ['secret_flag', 'gh-cli --token hunter2'],
    ['secret_flag', 'deploy --api-key=hunter2'],
    ['secret_flag', 'vault --secret "two words"'],
    ['inline_password_flag', 'tool --password hunter2'],
    ['curl_user', 'curl -u admin:hunter2 https://x.example'],
  ];
  const leaked = /hunter2|dXNlcjpw|k3y-v4lue|wJalrX|abc123|k-123456|s3cr3t|two words|a1B2a1B2|xxxxxxxxxx|Ab3Ab3|bbbbbbbbbb|a0Aba0Ab/;
  for (const [kind, input] of cases) {
    it(`${kind}: ${input}`, () => {
      const out = redact(input);
      expect(out.redactions).toContain(kind);
      expect(out.text).not.toMatch(leaked);
    });
  }

  it('leaves ordinary words and telemetry keys alone', () => {
    for (const text of [
      'git log --author=alice --since=1.week',
      'npm run passthrough=1',
      'first pass: refactor the parser',
      'max_tokens: 4096, token_count=3, input_tokens=12',
      'authorization header is missing',
    ]) {
      expect(redact(text).text, text).toBe(text);
    }
  });

  it('treats a 40-hex SHA exactly as before (generic_hex only)', () => {
    expect(redact('commit 3f786850e387550fdab836ed7e6dc881de23001b').redactions).toEqual(['generic_hex_secret']);
    expect(redact('commit 3f78685').redactions).toEqual([]);
  });

  it('does not double-count a value an earlier rule already redacted', () => {
    expect(redact('API_TOKEN=abc npm test').counts).toEqual({ env_assignment: 1 });
    expect(redact('mytool --token=abc').counts).toEqual({ secret_flag: 1 });
  });
});

describe('compileRules — polynomial backtracking', () => {
  it('allows one unbounded quantifier, keeps a normal rule, reports the index only', () => {
    const skipped: string[] = [];
    const rules = compileRules(
      [
        { pattern: '[a-z]*[a-z]*[a-z]*[a-z]*[a-z]*Z', replacement: 'x' },
        { pattern: 'ACME-[0-9]{4,}-[A-Z]{2}', replacement: '[ACME]' },
        { pattern: 'a{2,}b{3,}c+', replacement: 'x' },
        { pattern: '[*+]{2}\\*\\+x', replacement: 'y' },
      ],
      (message) => skipped.push(message),
    );
    expect(rules.map((r) => r.name)).toEqual(['org_rule_1', 'org_rule_3']);
    expect(skipped).toEqual([
      'org redaction rule #0 skipped: too many unbounded quantifiers',
      'org redaction rule #2 skipped: too many unbounded quantifiers',
    ]);
  });

  it('rejects two unbounded quantifiers, counting a large {n,m} as unbounded', () => {
    for (const pattern of ['[a-z]*[a-z]*Z', '.*.*Z', 'a{1,}a{1,}Z', '(?:a+)(?:a+)Z', '.{0,4000}.{0,4000}Z']) {
      expect(compileRules([{ pattern, replacement: 'x' }]), pattern).toEqual([]);
    }
    for (const pattern of ['ACME-[0-9]{6}', 'secret_[a-z0-9]+', 'x.{0,99}.{0,99}y+']) {
      expect(compileRules([{ pattern, replacement: 'x' }]), pattern).toHaveLength(1);
    }
    // Still rejected for nesting even with a single outer quantifier.
    expect(compileRules([{ pattern: '(a+)+', replacement: 'x' }])).toEqual([]);
  });
});

describe('prefixed tokens inside identifiers', () => {
  const tokens: [string, string][] = [
    ['aws_access_key', 'AKIAIOSFODNN7EXAMPLE'],
    ['google_api_key', `AIza${'B'.repeat(35)}`],
    ['google_oauth_token', `ya29.${'a0Ab'.repeat(10)}`],
    ['npm_token', `npm_${'a1B2'.repeat(9)}`],
    ['gitlab_token', `glpat-${'x'.repeat(20)}`],
    ['huggingface_token', `hf_${'Ab3'.repeat(12)}`],
    ['sendgrid_key', `SG.${'a'.repeat(22)}.${'b'.repeat(43)}`],
    ['agentstrack_key', `at_live_${'a'.repeat(16)}_${'z'.repeat(30)}`],
    ['jwt', `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`],
  ];
  for (const [kind, token] of tokens) {
    it(`${kind} in an MCP tool name and a snake_case identifier`, () => {
      for (const input of [`mcp__${token}__get`, `x_${token}`, `srv_${token}_y`]) {
        const out = redact(input);
        expect(out.text, input).not.toContain(token);
        expect(out.redactions, input).toContain(kind);
      }
    });
  }

  it('still leaves a token-like run inside a longer alphanumeric word alone', () => {
    expect(redact(`xAKIAIOSFODNN7EXAMPLE`).redactions).not.toContain('aws_access_key');
    expect(redact(`foonpm_${'a'.repeat(36)}`).redactions).not.toContain('npm_token');
  });
});

describe('secret patterns — escaped JSON, more keys, flags and headers', () => {
  const cases: [string, string][] = [
    ['secret_assignment', 'curl -d "{\\"password\\":\\"hunter2\\"}" https://x.example'],
    ['secret_assignment', '{\\"token\\":\\"hunter2\\"}'],
    ['secret_assignment', '{\\"auth\\":\\"hunter2\\"}'],
    ['secret_assignment', '{"password":"hun\\"hunter2"}'],
    ['secret_assignment', 'secret_key=hunter2'],
    ['secret_assignment', 'secretKey: hunter2'],
    ['secret_assignment', 'pwd=hunter2'],
    ['secret_flag', 'app --client-secret hunter2'],
    ['secret_flag', 'app --secret-key=hunter2'],
    ['token_auth_header', 'curl -H "Authorization: Token hunter2" https://x.example'],
    ['cookie_header', 'curl -H "Cookie: sid=hunter2; theme=dark" https://x.example'],
    ['cookie_header', 'Set-Cookie: sid=hunter2; Path=/; HttpOnly'],
  ];
  for (const [kind, input] of cases) {
    it(`${kind}: ${input}`, () => {
      const out = redact(input);
      expect(out.redactions).toContain(kind);
      expect(out.text).not.toContain('hunter2');
    });
  }

  it('redacts the whole cookie header, not just the first pair', () => {
    expect(redact('Cookie: a=1; b=2').text).toBe('Cookie: [REDACTED]');
  });

  it('keeps the no-false-positive cases', () => {
    for (const text of ['git log --author=alice', 'npm run passthrough=1', 'max_tokens: 4096', 'token_count=3', 'git checkout feature/token-refresh']) {
      expect(redact(text).text, text).toBe(text);
    }
  });

  it('stays linear on adversarial 100k inputs', () => {
    const inputs = [
      'password="' + 'a'.repeat(100_000),
      '\\"password\\":\\"' + '\\a'.repeat(50_000),
      'token:"'.repeat(15_000),
      '\\"'.repeat(50_000),
      'cookie:' + ' '.repeat(100_000),
      'Authorization: token '.repeat(5_000),
      '--x-'.repeat(25_000) + 'secret',
      'a.'.repeat(50_000) + '=',
      'auth="' + '\\'.repeat(100_000),
      'curl -u '.repeat(12_500),
      ' mysql x'.repeat(12_500),
    ];
    for (const input of inputs) {
      const started = performance.now();
      redact(input);
      expect(performance.now() - started, input.slice(0, 12)).toBeLessThan(500);
    }
  });
});

describe('commandName — quoted assignments', () => {
  it('skips a NAME="quoted value" assignment as one word', () => {
    expect(commandName('PASSWORD="my pass phrase" mysql -h x')).toBe('mysql');
    expect(commandName("A='x y' B=2 env -i make")).toBe('make');
  });
});
