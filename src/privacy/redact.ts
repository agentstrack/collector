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
  /**
   * When true, the rule only ever sees the first {@link ORG_SUBJECT_CAP} bytes
   * of the subject. Set on org-supplied rules so an untrusted pattern's
   * worst-case backtracking is bounded by input length as well as by the
   * complexity guard in {@link compileRules}.
   */
  capSubject?: boolean;
}

/** Org rules run on at most this many characters; built-ins see the whole value. */
export const ORG_SUBJECT_CAP = 64 * 1024;

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
  // `--password=SECRET` / `--password SECRET`, on any command: the long form
  // means one thing everywhere, so it needs no anchor.
  { name: 'inline_password_flag', pattern: /(--password[= ])(?!\s)("[^"]*"|'[^']*'|\S+)/g, replacement: '$1[REDACTED]' },
  // The short `-pSECRET` form, anchored to the commands that actually read
  // `-p` as a password. Unanchored it matched `find -path`, `find -print`,
  // `tar -pxzf` and `ssh -p2222` — flags an agent runs dozens of times an
  // hour — and every one of those became a "rotate an exposed credential"
  // alert with no credential behind it. A rule that cries wolf that often is
  // worse than no rule: the real one gets filtered with the rest.
  {
    name: 'inline_password_flag',
    pattern: /((?:^|[|;&]\s*|\s)(?:mysql|mysqladmin|mysqldump|mysqlshow|mariadb|mariadb-dump|mongo|mongosh|sshpass|smbclient)\b[^\n|;&]*?(?<![\w-])-p)(?!\s)("[^"]*"|'[^']*'|\S+)/g,
    replacement: '$1[REDACTED]',
  },
  { name: 'generic_hex_secret', pattern: /\b[a-f0-9]{40,}\b/g, replacement: '[REDACTED:hex]' },
];

export interface RedactionResult {
  text: string;
  /** Reported kinds of the rules that fired, for the trust metrics in BLUEPRINT §14. */
  redactions: string[];
  /** How many matches each reported kind replaced. Never the matched text. */
  counts: Record<string, number>;
}

/** The one kind reported for any rule that is not built in. */
export const ORG_RULE_KIND = 'org_rule';

const BUILTIN_NAMES = new Set(BUILTIN_RULES.map((rule) => rule.name));

/**
 * An org's own rule name can itself describe the shape of that org's secrets
 * ("acme_prod_db_password"), which is their business and not ours to ship back
 * to the server. Anything not built in therefore reports as one generic kind.
 */
const reportedKind = (name: string): string => (BUILTIN_NAMES.has(name) ? name : ORG_RULE_KIND);

export function redact(input: string, extraRules: RedactionRule[] = []): RedactionResult {
  let text = input;
  const counts: Record<string, number> = {};

  for (const rule of [...BUILTIN_RULES, ...extraRules]) {
    // Org rules see only a bounded prefix; the untouched tail is re-appended.
    const capped = rule.capSubject === true && text.length > ORG_SUBJECT_CAP;
    const subject = capped ? text.slice(0, ORG_SUBJECT_CAP) : text;
    // Fresh lastIndex per call: these regexes are global and module-level, so
    // reusing them statefully across calls would skip matches.
    rule.pattern.lastIndex = 0;
    // `match` on a global regex returns every match, so the tally is a count of
    // matches rather than of rules. Only the length is ever read.
    const hits = subject.match(rule.pattern)?.length ?? 0;
    if (hits === 0) continue;
    rule.pattern.lastIndex = 0;
    const replaced = subject.replace(rule.pattern, rule.replacement);
    text = capped ? replaced + text.slice(ORG_SUBJECT_CAP) : replaced;
    const kind = reportedKind(rule.name);
    counts[kind] = (counts[kind] ?? 0) + hits;
  }

  return { text, redactions: Object.keys(counts), counts };
}

/**
 * An org rule is rejected before compilation when its source is longer than
 * this, contains a nested quantifier, or uses a backreference — all shapes that
 * invite catastrophic backtracking on V8's engine, which runs single-threaded
 * on the daemon and would hang the whole collector.
 */
const MAX_ORG_PATTERN_LENGTH = 256;
// A quantified group whose body holds a quantifier, an alternation or an
// interval — directly or in one nested group. A heuristic: it rejects the
// common catastrophic shapes, not every regex that can blow up.
const NESTED_QUANTIFIER =
  /\((?:[^()]|\([^()]*\))*(?:[+*?|{]|\([^()]*[+*?|{][^()]*\))(?:[^()]|\([^()]*\))*\)[+*?{]/;
const BACKREFERENCE = /\\[1-9]|\\k</;

/** Compiles org-supplied patterns, skipping any unsafe or malformed rule. */
export function compileRules(
  rules: { pattern: string; replacement: string }[],
): RedactionRule[] {
  const compiled: RedactionRule[] = [];
  for (const [index, rule] of rules.entries()) {
    if (
      rule.pattern.length > MAX_ORG_PATTERN_LENGTH ||
      NESTED_QUANTIFIER.test(rule.pattern) ||
      BACKREFERENCE.test(rule.pattern)
    ) {
      // Same policy as a malformed rule: log-and-skip rather than stop the
      // collector. (Logging happens at the call site, which holds the logger.)
      continue;
    }
    try {
      compiled.push({
        name: `org_rule_${index}`,
        pattern: new RegExp(rule.pattern, 'g'),
        replacement: rule.replacement,
        capSubject: true,
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
