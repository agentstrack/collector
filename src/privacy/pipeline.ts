import type { Config } from '../config.js';
import { commandName, compileRules, redact, type RedactionRule } from './redact.js';
import { normalizePath } from './paths.js';
import type { EventEnvelope } from '../schema.js';

/**
 * The privacy pipeline from BLUEPRINT §9.3, applied to every event before it
 * enters the upload spool:
 *
 *   raw event -> policy lookup -> secret detection -> path/content redaction
 *   -> optional local classification -> optional local summary
 *   -> raw content discard -> normalized event
 *
 * Enforced here, on the developer's machine. By the time an event reaches the
 * spool there is nothing left to leak.
 */
export interface PipelineContext {
  config: Config;
  projectRoot?: string;
  orgRules?: { pattern: string; replacement: string }[];
}

export interface PipelineResult {
  event: EventEnvelope;
  redactions: string[];
}

/** Payload keys that carry free text and must always be scanned for secrets. */
const TEXT_KEYS = ['prompt_text', 'derived_title', 'message', 'command'] as const;

export function applyPrivacy(event: EventEnvelope, ctx: PipelineContext): PipelineResult {
  const mode = ctx.config.privacy.mode;
  const policy = ctx.config.privacy;
  const extraRules: RedactionRule[] = compileRules(ctx.orgRules ?? []);
  const redactions: string[] = [];
  const payload: Record<string, unknown> = { ...event.payload };

  // --- content: strip anything the mode does not permit -------------------
  if (mode === 'metadata') {
    // Counts and timings only. Titles are derived from prompts, so they go too.
    delete payload['prompt_text'];
    delete payload['derived_title'];
    delete payload['message'];
    // A shell command line IS content: it carries hostnames, client names,
    // usernames and inline passwords. `metadata` promises none of that, so the
    // binary name is all that may travel regardless of shell_arguments.
    if (typeof payload['command'] === 'string') {
      payload['command'] = commandName(payload['command']);
    }
  } else if (mode === 'analytics') {
    // Locally derived summaries may travel; the prompt itself never does.
    delete payload['prompt_text'];
    // `prompts: never` is stricter than the mode and must still be honoured —
    // it previously only took effect in `full` mode, making it a privacy
    // control that silently did nothing.
    if (policy.prompts === 'never') delete payload['derived_title'];
  } else if (policy.prompts !== 'full') {
    // 'full' mode still honours a stricter prompts policy.
    delete payload['prompt_text'];
    // ...including the locally derived summary. `never` means nothing
    // prompt-derived leaves the machine, in every mode — not just analytics.
    if (policy.prompts === 'never') delete payload['derived_title'];
  }

  // --- code content -------------------------------------------------------
  // `code_content: never` is the default and means exactly that: file bodies
  // and diffs are dropped regardless of mode, so opting into `full` prompts
  // does not silently opt into shipping source code.
  if (policy.code_content === 'never') {
    delete payload['content'];
    delete payload['diff'];
    delete payload['old_string'];
    delete payload['new_string'];
  }

  // --- secret detection on whatever text survives -------------------------
  for (const key of TEXT_KEYS) {
    const value = payload[key];
    if (typeof value !== 'string') continue;
    const result = redact(value, extraRules);
    payload[key] = result.text;
    redactions.push(...result.redactions);
  }

  // --- paths --------------------------------------------------------------
  if (typeof payload['path'] === 'string') {
    const normalized = normalizePath(payload['path'], ctx.projectRoot, policy.file_paths);
    if (normalized === null) delete payload['path'];
    else payload['path'] = normalized;
  }

  // `cwd` on session.started IS the project root, so it gets the same treatment
  // as repo.project_path — an absolute path leaks the username, the client name
  // and the directory tree, and it was travelling in metadata mode untouched.
  if (typeof payload['cwd'] === 'string' && policy.file_paths !== 'absolute') {
    delete payload['cwd'];
  }

  const repo = payload['repo'];
  if (repo && typeof repo === 'object') {
    const r = { ...(repo as Record<string, unknown>) };
    if (policy.file_paths === 'never') delete r['project_path'];
    else if (typeof r['project_path'] === 'string' && policy.file_paths === 'relative') {
      // The project root itself is only ever sent as a hash, never a path.
      delete r['project_path'];
    }
    payload['repo'] = r;
  }

  // --- account identity ---------------------------------------------------
  // `key` is an opaque provider account id and always travels: it is the only
  // thing that keeps two accounts' sessions apart, and in `metadata` mode the
  // account must still show up as a distinct (if anonymous) identity rather
  // than merging into everyone else's. `label` is an email or display name and
  // `org` is an employer — both name a human, so they are content and are
  // dropped below `analytics` exactly like a prompt is.
  const account = payload['account'];
  if (account && typeof account === 'object' && !Array.isArray(account)) {
    const a = account as Record<string, unknown>;
    const trimmed: Record<string, unknown> = { key: a['key'] };
    if (a['provider'] !== undefined) trimmed['provider'] = a['provider'];
    if (mode !== 'metadata') {
      if (a['label'] !== undefined) trimmed['label'] = a['label'];
      if (a['org'] !== undefined) trimmed['org'] = a['org'];
    }
    payload['account'] = trimmed;
  }

  // --- shell arguments ----------------------------------------------------
  if (typeof payload['command'] === 'string' && policy.shell_arguments === 'never') {
    payload['command'] = payload['command'].split(/\s+/)[0] ?? '';
  }

  return { event: { ...event, payload }, redactions };
}
