/**
 * Secret detection and redaction.
 *
 * This runs on the developer's machine, before anything is uploaded. It is the
 * first line of defence, not the last: in `metadata` mode there is simply no
 * content to leak because it was discarded here.
 *
 * Patterns are ordered most-specific first so a token that matches two rules
 * is labelled by the more precise one.
 */
export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

export const BUILTIN_RULES: RedactionRule[] = [
  { name: 'anthropic_key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED:anthropic_key]' },
  { name: 'openai_key', pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED:openai_key]' },
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9]{16,}/g, replacement: '[REDACTED:github_token]' },
  { name: 'github_pat', pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: '[REDACTED:github_pat]' },
  { name: 'slack_token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: '[REDACTED:slack_token]' },
  { name: 'stripe_key', pattern: /[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, replacement: '[REDACTED:stripe_key]' },
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replacement: '[REDACTED:aws_access_key]' },
  { name: 'google_api_key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g, replacement: '[REDACTED:google_api_key]' },
  { name: 'agentstrack_key', pattern: /\bat_(?:live|test)_[a-f0-9]{16}_[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED:agentstrack_key]' },
  { name: 'private_key', pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED:private_key]' },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: '[REDACTED:jwt]' },
  { name: 'bearer_header', pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g, replacement: 'Bearer [REDACTED]' },
  { name: 'basic_auth_url', pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/g, replacement: '$1[REDACTED]@' },
  { name: 'env_assignment', pattern: /\b([A-Z_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/g, replacement: '$1=[REDACTED]' },
  { name: 'generic_hex_secret', pattern: /\b[a-f0-9]{40,}\b/g, replacement: '[REDACTED:hex]' },
];

export interface RedactionResult {
  text: string;
  /** Names of rules that fired, for the trust metrics in BLUEPRINT §14. */
  redactions: string[];
}

export function redact(input: string, extraRules: RedactionRule[] = []): RedactionResult {
  let text = input;
  const redactions: string[] = [];

  for (const rule of [...BUILTIN_RULES, ...extraRules]) {
    // Fresh lastIndex per call: these regexes are global and module-level, so
    // reusing them statefully across calls would skip matches.
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(text)) continue;
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, rule.replacement);
    redactions.push(rule.name);
  }

  return { text, redactions };
}

/** Compiles org-supplied patterns, skipping any that do not compile. */
export function compileRules(
  rules: { pattern: string; replacement: string }[],
): RedactionRule[] {
  const compiled: RedactionRule[] = [];
  for (const [index, rule] of rules.entries()) {
    try {
      compiled.push({
        name: `org_rule_${index}`,
        pattern: new RegExp(rule.pattern, 'g'),
        replacement: rule.replacement,
      });
    } catch {
      // A malformed server-side rule must not stop the collector entirely.
    }
  }
  return compiled;
}

/** Extracts the binary name, dropping arguments that may hold secrets. */
export function commandName(commandLine: string): string {
  const first = commandLine.trim().split(/\s+/)[0] ?? '';
  return first.split('/').pop() ?? first;
}
