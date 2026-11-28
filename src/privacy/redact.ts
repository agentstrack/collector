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

// Prefixed tokens are anchored on alphanumerics, not `\b`: `_` is a word
// character, so `\bnpm_…` missed a token embedded in an MCP tool name
// (`mcp__npm_<36>__get`) or a snake_case identifier (`srv_hf_…`).
export const BUILTIN_RULES: RedactionRule[] = [
  { name: 'anthropic_key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED:anthropic_key]' },
  { name: 'openai_key', pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED:openai_key]' },
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9]{16,}/g, replacement: '[REDACTED:github_token]' },
  { name: 'github_pat', pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: '[REDACTED:github_pat]' },
  { name: 'slack_token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: '[REDACTED:slack_token]' },
  { name: 'stripe_key', pattern: /[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, replacement: '[REDACTED:stripe_key]' },
  { name: 'aws_access_key', pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, replacement: '[REDACTED:aws_access_key]' },
  { name: 'google_api_key', pattern: /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9])/g, replacement: '[REDACTED:google_api_key]' },
  { name: 'google_oauth_token', pattern: /(?<![A-Za-z0-9])ya29\.[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED:google_oauth_token]' },
  { name: 'npm_token', pattern: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g, replacement: '[REDACTED:npm_token]' },
  { name: 'gitlab_token', pattern: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED:gitlab_token]' },
  { name: 'huggingface_token', pattern: /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}(?![A-Za-z0-9])/g, replacement: '[REDACTED:huggingface_token]' },
  { name: 'sendgrid_key', pattern: /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, replacement: '[REDACTED:sendgrid_key]' },
  { name: 'agentstrack_key', pattern: /(?<![A-Za-z0-9])at_(?:live|test)_[a-f0-9]{16}_[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED:agentstrack_key]' },
  { name: 'private_key', pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED:private_key]' },
  { name: 'jwt', pattern: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9])/g, replacement: '[REDACTED:jwt]' },
  { name: 'bearer_header', pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g, replacement: 'Bearer [REDACTED]' },
  { name: 'basic_auth_header', pattern: /\b(authorization:\s*basic\s+)[A-Za-z0-9+/]{8,}=*/gi, replacement: '$1[REDACTED]' },
  { name: 'token_auth_header', pattern: /\b(authorization:\s*token\s+)[^\s"'\\]+/gi, replacement: '$1[REDACTED]' },
  // Every cookie on the line is a session credential; the header runs to the
  // end of the line or the shell string that holds it.
  { name: 'cookie_header', pattern: /\b((?:set-)?cookie:[ \t]*)[^\r\n"'\\]+/gi, replacement: '$1[REDACTED]' },
  { name: 'basic_auth_url', pattern: /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/g, replacement: '$1[REDACTED]@' },
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
    pattern: /(--(?:token|api-key|apikey|(?:\w+-)?secret(?:-key)?|auth-token|access-token)[= ])(?!\s)(?!\[REDACTED)("[^"]*"|'[^']*'|\S+)/g,
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
  // lookbehind admits one start per key, keeping the scan linear. Quotes may be
  // backslash-escaped (JSON inside a shell string: `-d "{\"password\":\"x\"}"`),
  // and a quoted value may itself contain escapes.
  {
    name: 'secret_assignment',
    pattern: /(?<![A-Za-z0-9_.-])((\\?["']?)[A-Za-z0-9_.-]*?(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|secret[_-]?key)\2\s*[:=]\s*)(?!\[REDACTED)(\\"(?:[^"\\]|\\[^"])*\\"|"(?:[^"\\]|\\.)*"|'[^']*'|[^\s&,;"'}\]]+)/gi,
    replacement: '$1[REDACTED]',
  },
  // `pass` and `auth` are ordinary words ("first pass: …"), so as a bare key
  // they count only with `=` (env, query string, flag) or as a quoted JSON key.
  // Segment-delimited, so `passthrough=1` and `--author=x` are left alone.
  {
    name: 'secret_assignment',
    pattern: /(?<![A-Za-z0-9_.-])((?:[A-Za-z0-9]+[_.-])*(?:pass|auth)\s*=\s*|\\?"(?:[A-Za-z0-9]+[_.-])*(?:pass|auth)\\?"\s*:\s*)(?!\[REDACTED)(\\"(?:[^"\\]|\\[^"])*\\"|"(?:[^"\\]|\\.)*"|'[^']*'|[^\s&,;"'}\]]+)/gi,
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
 * Unbounded quantifiers (`*`, `+`, `{n,}`, and `{n,m}` with m >= 100) outside
 * character classes. Two in a row already go quadratic without nesting:
 * `.*.*Z` passes the nested-quantifier check and is O(n^2) on a miss.
 * ponytail: a counting heuristic, not a proof — one unbounded quantifier per
 * pattern, plus the nested-quantifier and backreference rejections. The
 * upgrade path is running org rules in a worker thread with a timeout.
 */
const MAX_UNBOUNDED_QUANTIFIERS = 1;
const LARGE_INTERVAL = 100;

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
    else if (ch === '{') {
      const interval = /^\{\d+,(\d*)\}/.exec(source.slice(i));
      if (interval && (interval[1] === '' || Number(interval[1]) >= LARGE_INTERVAL)) count += 1;
    }
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
  // Quote-aware words, so `PASSWORD="my pass phrase" mysql` is one assignment.
  for (const [word] of commandLine.matchAll(/(?:"[^"]*"|'[^']*'|[^\s"']+)+/g)) {
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
