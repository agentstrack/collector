import { describe, expect, it } from 'vitest';
import { applyPrivacy } from './pipeline.js';
import { Config } from '../config.js';
import { SCHEMA_VERSION, type EventEnvelope } from '../schema.js';

const config = (mode: 'metadata' | 'analytics' | 'full', overrides = {}) =>
  Config.parse({ privacy: { mode, ...overrides } });

const promptEvent = (): EventEnvelope => ({
  event_id: '00000000-0000-4000-8000-000000000001',
  schema_version: SCHEMA_VERSION,
  occurred_at: '2026-08-26T10:00:00.000Z',
  collector_id: '00000000-0000-4000-8000-000000000000',
  session_id: 's1',
  agent: 'claude_code',
  event_type: 'user.prompted',
  payload: {
    prompt_chars: 64,
    prompt_text: 'Deploy using AWS key AKIAIOSFODNN7EXAMPLE to the prod cluster',
    derived_title: 'Deploy to the prod cluster',
  },
});

describe('privacy pipeline — BLUEPRINT §9.3', () => {
  it('metadata mode sends counts only: no prompt, no title', () => {
    const { event } = applyPrivacy(promptEvent(), { config: config('metadata') });
    expect(event.payload['prompt_text']).toBeUndefined();
    expect(event.payload['derived_title']).toBeUndefined();
    expect(event.payload['prompt_chars']).toBe(64);
  });

  it('analytics mode keeps the local title but never the prompt', () => {
    const { event } = applyPrivacy(promptEvent(), { config: config('analytics') });
    expect(event.payload['prompt_text']).toBeUndefined();
    expect(event.payload['derived_title']).toBe('Deploy to the prod cluster');
  });

  it('full mode may send the prompt, but only after secret redaction', () => {
    const { event, redactions } = applyPrivacy(promptEvent(), {
      config: config('full', { prompts: 'full' }),
    });
    const text = event.payload['prompt_text'] as string;
    expect(text).toBeDefined();
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redactions).toContain('aws_access_key');
  });

  it('a stricter local prompts policy overrides full mode', () => {
    const { event } = applyPrivacy(promptEvent(), {
      config: config('full', { prompts: 'never' }),
    });
    expect(event.payload['prompt_text']).toBeUndefined();
  });

  it('redacts secrets that leaked into a derived title, in every mode', () => {
    const event = promptEvent();
    event.payload['derived_title'] = 'use ghp_' + 'a'.repeat(36) + ' to push';
    for (const mode of ['analytics', 'full'] as const) {
      const result = applyPrivacy(structuredClone(event), { config: config(mode, { prompts: 'full' }) });
      const title = result.event.payload['derived_title'];
      if (typeof title === 'string') expect(title).not.toContain('ghp_aaaa');
    }
  });

  it('relativizes file paths so absolute paths never leave the machine', () => {
    const event: EventEnvelope = {
      ...promptEvent(),
      event_type: 'file.changed',
      payload: { path: '/Users/dev/Web/api/src/secret-client/auth.ts' },
    };
    const { event: out } = applyPrivacy(event, {
      config: config('analytics'),
      projectRoot: '/Users/dev/Web/api',
    });
    expect(out.payload['path']).toBe('src/secret-client/auth.ts');
    expect(String(out.payload['path'])).not.toContain('/Users/dev');
  });

  it('drops paths entirely when file_paths is never', () => {
    const event: EventEnvelope = {
      ...promptEvent(),
      event_type: 'file.changed',
      payload: { path: '/Users/dev/Web/api/src/a.ts' },
    };
    const { event: out } = applyPrivacy(event, { config: config('analytics', { file_paths: 'never' }) });
    expect(out.payload['path']).toBeUndefined();
  });

  it('never sends the project path in relative mode — only the repo hash correlates', () => {
    const event: EventEnvelope = {
      ...promptEvent(),
      event_type: 'session.started',
      payload: { repo: { project_path: '/Users/dev/clients/acme-secret', remote_hash: 'abc123' } },
    };
    const { event: out } = applyPrivacy(event, { config: config('analytics') });
    const repo = out.payload['repo'] as Record<string, unknown>;
    expect(repo['project_path']).toBeUndefined();
    expect(repo['remote_hash']).toBe('abc123');
  });

  it('reduces a command to its binary when shell_arguments is never', () => {
    const event: EventEnvelope = {
      ...promptEvent(),
      event_type: 'command.executed',
      payload: { command: 'psql --password=hunter2 -h prod' },
    };
    const { event: out } = applyPrivacy(event, { config: config('analytics', { shell_arguments: 'never' }) });
    expect(out.payload['command']).toBe('psql');
  });

  it('redacts secrets in command arguments by default', () => {
    const event: EventEnvelope = {
      ...promptEvent(),
      event_type: 'command.executed',
      payload: { command: 'curl -H "Authorization: Bearer ' + 'z'.repeat(40) + '" https://api.example.com' },
    };
    const { event: out } = applyPrivacy(event, { config: config('analytics') });
    expect(out.payload['command']).toContain('Bearer [REDACTED]');
  });

  it('applies org-supplied redaction rules on top of the built-ins', () => {
    const event = promptEvent();
    event.payload['derived_title'] = 'Work on INTERNAL-9931';
    const { event: out } = applyPrivacy(event, {
      config: config('analytics'),
      orgRules: [{ pattern: 'INTERNAL-\\d+', replacement: '[TICKET]' }],
    });
    expect(out.payload['derived_title']).toBe('Work on [TICKET]');
  });

  it('does not mutate the input event', () => {
    const event = promptEvent();
    const before = structuredClone(event);
    applyPrivacy(event, { config: config('metadata') });
    expect(event).toEqual(before);
  });
});

describe('code content', () => {
  it('drops file bodies and diffs by default, even in full mode', () => {
    // Opting into prompt upload must not silently opt into shipping source.
    const event: EventEnvelope = {
      ...promptEvent(),
      event_type: 'file.changed',
      payload: {
        path: 'src/a.ts',
        content: 'const SECRET_LOGIC = 1;',
        diff: '- old\n+ new',
        old_string: 'old',
        new_string: 'new',
      },
    };
    const { event: out } = applyPrivacy(event, { config: config('full', { prompts: 'full' }) });
    for (const key of ['content', 'diff', 'old_string', 'new_string']) {
      expect(out.payload[key], key).toBeUndefined();
    }
    expect(out.payload['path']).toBeDefined();
  });

  it('retains code only when explicitly opted in', () => {
    const event: EventEnvelope = {
      ...promptEvent(),
      event_type: 'file.changed',
      payload: { path: 'src/a.ts', content: 'const x = 1;' },
    };
    const { event: out } = applyPrivacy(event, {
      config: config('full', { prompts: 'full', code_content: 'full' }),
    });
    expect(out.payload['content']).toBe('const x = 1;');
  });
});

describe('prompts policy is honoured independently of the mode', () => {
  it('prompts: never also strips the locally derived title in analytics mode', () => {
    // Regression: `prompts` was only consulted inside the `full` branch, so
    // selecting `never` changed nothing in the default mode.
    const { event } = applyPrivacy(promptEvent(), {
      config: config('analytics', { prompts: 'never' }),
    });
    expect(event.payload['prompt_text']).toBeUndefined();
    expect(event.payload['derived_title']).toBeUndefined();
    expect(event.payload['prompt_chars']).toBe(64);
  });

  it('prompts: never strips the derived title in FULL mode too', () => {
    // Regression: the `never` check lived only in the analytics branch, so a
    // user on `full` who asked for no prompt-derived data still shipped the
    // locally generated summary of their prompt.
    const { event } = applyPrivacy(promptEvent(), { config: config('full', { prompts: 'never' }) });
    expect(event.payload['prompt_text']).toBeUndefined();
    expect(event.payload['derived_title']).toBeUndefined();
  });

  it('never means never in every mode', () => {
    for (const mode of ['metadata', 'analytics', 'full'] as const) {
      const { event } = applyPrivacy(promptEvent(), { config: config(mode, { prompts: 'never' }) });
      expect(event.payload['derived_title'], mode).toBeUndefined();
      expect(event.payload['prompt_text'], mode).toBeUndefined();
    }
  });

  it('still sends the title under the default local_summary_only', () => {
    const { event } = applyPrivacy(promptEvent(), { config: config('analytics') });
    expect(event.payload['derived_title']).toBe('Deploy to the prod cluster');
  });
});

describe('privacy pipeline — account attribution', () => {
  const withAccount = (): EventEnvelope => ({
    ...promptEvent(),
    payload: {
      prompt_chars: 4,
      account: {
        key: '11111111-2222-4333-8444-555555555555',
        label: 'ada@acme.dev',
        org: 'Acme Inc',
        provider: 'anthropic',
      },
    },
  });

  it('metadata mode keeps the opaque key but strips label and org', () => {
    // Sessions must still SPLIT per account in metadata mode — that is what
    // `key` is for. An email and an employer are PII and must not travel.
    const { event } = applyPrivacy(withAccount(), { config: config('metadata') });
    expect(event.payload['account']).toEqual({
      key: '11111111-2222-4333-8444-555555555555',
      provider: 'anthropic',
    });
  });

  it('analytics and full modes may name the account', () => {
    for (const mode of ['analytics', 'full'] as const) {
      const { event } = applyPrivacy(withAccount(), { config: config(mode) });
      expect(event.payload['account'], mode).toEqual({
        key: '11111111-2222-4333-8444-555555555555',
        provider: 'anthropic',
        label: 'ada@acme.dev',
        org: 'Acme Inc',
      });
    }
  });

  it('leaves events without an account alone', () => {
    const { event } = applyPrivacy(promptEvent(), { config: config('metadata') });
    expect(event.payload).not.toHaveProperty('account');
  });
});

describe('privacy pipeline — session cwd', () => {
  const startEvent = (): EventEnvelope => ({
    ...promptEvent(),
    event_type: 'session.started',
    payload: { external_session_id: 's1', cwd: '/Users/ada/clients/acme/api' },
  });

  it('drops the absolute project root unless file_paths is absolute', () => {
    // cwd is the project root by definition: it names the user and the client.
    for (const mode of ['metadata', 'analytics', 'full'] as const) {
      const { event } = applyPrivacy(startEvent(), { config: config(mode) });
      expect(event.payload, mode).not.toHaveProperty('cwd');
    }
  });

  it('keeps it when the developer has opted into absolute paths', () => {
    const { event } = applyPrivacy(startEvent(), { config: config('full', { file_paths: 'absolute' }) });
    expect(event.payload['cwd']).toBe('/Users/ada/clients/acme/api');
  });
});

describe('metadata mode treats a shell command as content', () => {
  const cmd = (): EventEnvelope => ({
    ...promptEvent(),
    event_type: 'command.executed',
    payload: { command: 'mysql -h prod-db.client.com -u root -pHunter2 acme -e "select * from wp_users"' },
  });

  it('ships only the binary name in metadata mode', () => {
    // Regression: the full command line shipped in every mode, carrying
    // hostnames, client names and inline passwords, while the mode promised
    // "counts and timings only".
    const { event } = applyPrivacy(cmd(), { config: config('metadata') });
    expect(event.payload['command']).toBe('mysql');
  });

  it('keeps the command in analytics mode but redacts the inline password', () => {
    const { event } = applyPrivacy(cmd(), { config: config('analytics') });
    const out = String(event.payload['command']);
    expect(out).toContain('mysql');
    expect(out).not.toContain('Hunter2');
  });

  it('never lets a credential through in any mode', () => {
    for (const mode of ['metadata', 'analytics', 'full'] as const) {
      const { event } = applyPrivacy(cmd(), { config: config(mode, { prompts: 'full' }) });
      expect(String(event.payload['command']), mode).not.toContain('Hunter2');
    }
  });
});
