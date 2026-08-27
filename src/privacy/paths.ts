import { relative, sep } from 'node:path';
import { homedir } from 'node:os';

/**
 * Path handling per privacy mode.
 *
 * An absolute path is itself disclosure — it leaks usernames, client names and
 * directory structure. `relative` (the default) keeps paths useful for
 * analytics while dropping everything above the project root.
 */
export type PathMode = 'never' | 'relative' | 'absolute';

export function normalizePath(path: string, projectRoot: string | undefined, mode: PathMode): string | null {
  if (mode === 'never') return null;
  if (mode === 'absolute') return path;

  if (projectRoot && path.startsWith(projectRoot)) {
    const rel = relative(projectRoot, path);
    return rel === '' ? '.' : rel;
  }

  // Outside the project: keep the shape, drop the identity.
  const home = homedir();
  if (path.startsWith(home)) return `~${path.slice(home.length)}`;

  // Unknown absolute path — keep only the last two segments so the file type
  // is still visible without revealing the tree it sits in.
  const parts = path.split(sep).filter(Boolean);
  return parts.length <= 2 ? path : `…${sep}${parts.slice(-2).join(sep)}`;
}

/** True when a project is on the user's exclusion list. */
export function isExcluded(projectPath: string, excluded: string[]): boolean {
  const home = homedir();
  const normalized = projectPath.replace(/\/+$/, '');
  return excluded.some((pattern) => {
    const expanded = pattern.replace(/^~/, home).replace(/\/+$/, '');
    return normalized === expanded || normalized.startsWith(`${expanded}${sep}`);
  });
}
