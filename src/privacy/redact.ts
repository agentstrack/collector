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
  { name: 'google_oauth_token', pattern: /\bya29\.[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED:google_oauth_token]' },
  { name: 'npm_token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replacement: '[REDACTED:npm_token]' },
  { name: 'gitlab_token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED:gitlab_token]' },
  { name: 'huggingface_token', pattern: /\bhf_[A-Za-z0-9]{30,}\b/g, replacement: '[REDACTED:huggingface_token]' },
  { name: 'sendgrid_key', pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, replacement: '[REDACTED:sendgrid_key]' },
  { name: 'agentstrack_key', pattern: /\bat_(?:live|test)_[a-f0-9]{16}_[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED:agentstrack_key]' },
  { name: 'private_key', pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED:private_key]' },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: '[REDACTED:jwt]' },
  { name: 'bearer_header', pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g, replacement: 'Bearer [REDACTED]' },
  { name: 'basic_auth_header', pattern: /\b(authorization:\s*basic\s+)[A-Za-z0-9+/]{8,}=*/gi, replacement: '$1[REDACTED]' },
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
  // `--token VALUE` / `--api-key=VALUE` and friends: like `--password`, the
  // long forms mean one thing on every CLI that has them.
  {
    name: 'secret_flag',
    pattern: /(--(?:token|api-key|apikey|secret|auth-token|access-token)[= ])(?!\s)(?!\[REDACTED)("[^"]*"|'[^']*'|\S+)/g,
    replacement: '$1[REDACTED]',
  },
  // `curl -u user:pass` — the credential is the whole `user:pass` word.
  {
    name: 'curl_user',
    pattern: /(\bcurl\b[^\n|;&]*?\s(?:-u|--user)[= ]?\s*)("[^"]*"|'[^']*'|[^\s:'"]+:\S+)/g,
    replacement: '$1[REDACTED]',
  },
  // `key=value`, `key: value`, `?access_token=…&` and JSON `"apiKey": "…"`,
  // any case, where the key ENDS in a secret-ish word. Ending, not containing:
  // `max_tokens: 4096` and `token_count=3` are telemetry, not credentials. The
  // lookbehind admits one start per key, keeping the scan linear.
  {
    name: 'secret_assignment',
    pattern: /(?<![A-Za-z0-9_.-])((["']?)[A-Za-z0-9_.-]*?(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key)\2\s*[:=]\s*)(?!\[REDACTED)("[^"]*"|'[^']*'|[^\s&,;"'}\]]+)/gi,
    replacement: '$1[REDACTED]',
  },
  // `pass` and `auth` are ordinary words ("first pass: …"), so as a bare key
  // they count only with `=` (env, query string, flag) or as a quoted JSON key.
  // Segment-delimited, so `passthrough=1` and `--author=x` are left alone.
  {
    name: 'secret_assignment',
    pattern: /(?<![A-Za-z0-9_.-])((?:[A-Za-z0-9]+[_.-])*(?:pass|auth)\s*=\s*|"(?:[A-Za-z0-9]+[_.-])*(?:pass|auth)"\s*:\s*)(?!\[REDACTED)("[^"]*"|'[^']*'|[^\s&,;"'}\]]+)/gi,
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

/**
 * Unbounded quantifiers (`*`, `+`, `{n,}`) outside character classes. Past two,
 * backtracking goes polynomial even without nesting: `[a-z]*[a-z]*[a-z]*…Z`
 * passes the nested-quantifier check and is still O(n^k) on a miss.
 */
const MAX_UNBOUNDED_QUANTIFIERS = 2;

function unboundedQuantifiers(source: string): number {
  let count = 0;
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === '*' || ch === '+') count += 1;
    else if (ch === '{' && /^\{\d+,\}/.test(source.slice(i))) count += 1;
  }
  return count;
}

function unsafeReason(pattern: string): string | null {
  if (pattern.length > MAX_ORG_PATTERN_LENGTH) return 'too long';
  if (NESTED_QUANTIFIER.test(pattern)) return 'nested quantifier';
  if (BACKREFERENCE.test(pattern)) return 'backreference';
  if (unboundedQuantifiers(pattern) > MAX_UNBOUNDED_QUANTIFIERS) return 'too many unbounded quantifiers';
  return null;
}

/**
 * Compiles org-supplied patterns, skipping any unsafe or malformed rule.
 *
 * `onSkip` hears the rule's index and the reason, never the pattern: it is org
 * config, not user content, but there is no reason to echo it into a log.
 */
export function compileRules(
  rules: { pattern: string; replacement: string }[],
  onSkip: (message: string) => void = () => {},
): RedactionRule[] {
  const compiled: RedactionRule[] = [];
  for (const [index, rule] of rules.entries()) {
    const unsafe = unsafeReason(rule.pattern);
    if (unsafe) {
      // Same policy as a malformed rule: skip rather than stop the collector.
      onSkip(`org redaction rule #${index} skipped: ${unsafe}`);
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
      onSkip(`org redaction rule #${index} skipped: invalid regex`);
    }
  }
  return compiled;
}

/** Prefixes that run the next word as the real command. */
const COMMAND_WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time']);

/**
 * Extracts the binary name, dropping arguments that may hold secrets.
 *
 * Leading `NAME=value` assignments and wrapper commands are skipped, or
 * `API_TOKEN=abc npm test` ships the token as the "binary". Flags directly
 * after a wrapper are skipped too (`env -i`, `sudo -E`).
 * ponytail: a wrapper flag that takes a value (`sudo -u root ls`) yields the
 * value; parse per-wrapper arity if that ever shows up in the data.
 */
export function commandName(commandLine: string): string {
  let afterWrapper = false;
  for (const word of commandLine.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (afterWrapper && word.startsWith('-')) continue;
    const base = word.split('/').pop() ?? word;
    if (COMMAND_WRAPPERS.has(base)) {
      afterWrapper = true;
      continue;
    }
    return base;
  }
  return '';
}
