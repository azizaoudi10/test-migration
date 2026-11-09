import { readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { PROJECT_SKIP_DIRS } from './skip-dirs.js';

/** Quick-open (Ctrl+P): bounded walk of a project root → file list. The
 *  result is cached per root for a few seconds so repeated palette opens are
 *  instant; the walk itself skips heavy/recursive dirs and hidden entries. */
const QUICK_OPEN_MAX = 5000;
const QUICK_OPEN_BUDGET_MS = 4_000;
const QUICK_OPEN_SKIP = PROJECT_SKIP_DIRS;
const QUICK_OPEN_CACHE_MS = 10_000;
const QUICK_OPEN_CACHE_MAX = 4;
/** Small LRU keyed by root: alternating projects no longer thrash a single
 *  entry, and fs mutations can invalidate precisely (audit PERF-4). */
const quickOpenCache = new Map<string, { at: number; files: Array<{ name: string; path: string }> }>();

/** Drops cached file lists rooted at or under `root` (a create/rename/delete
 *  must not serve stale palette results). */
export function invalidateProjectFiles(root: string): void {
  for (const key of [...quickOpenCache.keys()]) {
    if (key === root || key.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) quickOpenCache.delete(key);
  }
}

export async function listProjectFiles(root: string): Promise<Array<{ name: string; path: string }>> {
  const cached = quickOpenCache.get(root);
  if (cached && Date.now() - cached.at < QUICK_OPEN_CACHE_MS) return cached.files;
  const files: Array<{ name: string; path: string }> = [];
  // big vendor trees must not eat the whole budget silently — a hard cap
  // keeps the palette responsive on huge projects
  const deadline = Date.now() + QUICK_OPEN_BUDGET_MS;
  const stack = [root];
  while (stack.length > 0 && files.length < QUICK_OPEN_MAX && Date.now() < deadline) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip the subtree
    }
    for (const e of entries) {
      if (files.length >= QUICK_OPEN_MAX || Date.now() > deadline) break;
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (!QUICK_OPEN_SKIP.has(e.name)) stack.push(join(dir, e.name));
      } else if (e.isFile() || e.isSymbolicLink()) {
        files.push({ name: e.name, path: join(dir, e.name) });
      }
    }
  }
  quickOpenCache.set(root, { at: Date.now(), files });
  while (quickOpenCache.size > QUICK_OPEN_CACHE_MAX) {
    const oldest = quickOpenCache.keys().next().value;
    if (oldest === undefined) break;
    quickOpenCache.delete(oldest);
  }
  return files;
}
