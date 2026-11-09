import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { FORK_SKIP_DIRS } from './skip-dirs.js';

export type ForkResult = { ok: true; path: string } | { ok: false; error: string };

/** Written after a fork completes: forkExists() requires it, so a crash-left
 *  half-copy is never resumed as if it were real prior work (FORK-5). */
export const FORK_MARKER = '.fork-complete.json';

async function writeForkMarker(dest: string, src: string): Promise<void> {
  await writeFile(join(dest, FORK_MARKER), JSON.stringify({ at: Date.now(), src }), 'utf8').catch(() => undefined);
}

/** True when dest holds a COMPLETED fork (the marker from the last
 *  successful copy/clone). A non-empty half-copy is not resumable. */
export async function forkExists(dest: string): Promise<boolean> {
  try {
    if (!(await stat(dest)).isDirectory()) return false;
    await stat(join(dest, FORK_MARKER));
    return true;
  } catch {
    return false;
  }
}

/** Directories never carried into a fork — heavy or recursive by nature. */
const SKIP_DIRS = FORK_SKIP_DIRS;
const MAX_ENTRIES = 50_000;
/** Fork size budget: a checked-in dataset/blob must not fill the disk twice
 *  (audit FORK-1). */
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
/** Error codes meaning "this entry is unreadable or not a plain file" — a
 *  fork is best-effort: one permission-denied file must not abort the whole
 *  run. EISDIR covers symlinks pointing at directories; ELOOP a symlink
 *  cycle (audit FORK-3). */
const SKIPPABLE_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'EISDIR', 'ELOOP', 'ENAMETOOLONG']);

function isSkippable(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code !== undefined && SKIPPABLE_CODES.has(code);
}

/** Clones (git) or copies the project into a fresh fork folder.
 *  - git repos with a clean worktree: `git clone --local` (fast, history).
 *  - dirty worktrees and non-git projects: recursive copy with exclusions,
 *    so uncommitted work is included.
 *  - the destination is reset first; forking the home directory is refused
 *  (there is no project to fork).
 *  - keepExisting: when the destination already holds a non-empty fork,
 *  reuse it untouched (resume-in-place) instead of wiping it. */
export async function forkProject(src: string, dest: string, home: string, keepExisting = false): Promise<ForkResult> {
  let isDir = false;
  try {
    isDir = (await stat(src)).isDirectory();
  } catch {
    return { ok: false, error: 'project directory not found' };
  }
  if (!isDir) return { ok: false, error: 'project directory not found' };
  // normalize before the equality check: a trailing slash or symlink form
  // must not defeat the "cwd is home" guard (audit FORK-4)
  const realHome = await realpath(home).catch(() => resolve(home));
  const realSrc = await realpath(src).catch(() => resolve(src));
  if (realSrc === realHome) return { ok: false, error: 'no project to fork (cwd is the home directory)' };

  if (keepExisting && (await forkExists(dest))) return { ok: true, path: dest };

  try {
    await rm(dest, { recursive: true, force: true });
  } catch {
    // best effort — the fresh write below will surface real failures
  }

  const cleanWorktree = await new Promise<boolean>((resolve) => {
    execFile('git', ['status', '--porcelain'], { cwd: src, timeout: 15_000, windowsHide: true }, (err, out) => {
      resolve(err === null && out.trim().length === 0);
    });
  });

  if (cleanWorktree) {
    const cloned = await new Promise<boolean>((resolve) => {
      execFile('git', ['clone', '--local', '--quiet', src, dest], { timeout: 120_000, windowsHide: true }, (err, _out, stderr) => {
        if (err) console.error(`[fork] git clone failed (${err.message}): ${String(stderr).slice(0, 300)}`);
        resolve(err === null);
      });
    });
    if (cloned) {
      await writeForkMarker(dest, src);
      return { ok: true, path: dest };
    }
    // clone failed — a partial .git may have been left behind; the copy
    // fallback skips dotfiles, so it must start from a clean destination
    // (otherwise the fork would carry a corrupt repo the agents run git on)
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
  }

  let count = 0;
  let bytes = 0;
  try {
    await mkdir(dest, { recursive: true });
    const walk = async (from: string, to: string): Promise<boolean> => {
      let entries;
      try {
        entries = await readdir(from, { withFileTypes: true });
      } catch (err) {
        if (isSkippable(err)) return true; // unreadable directory — skip the subtree
        throw err;
      }
      for (const entry of entries) {
        // explicit deny-list only: dotfiles like .env/.npmrc are part of the
        // environment agents need (audit FORK-2)
        if (SKIP_DIRS.has(entry.name)) continue;
        if (++count > MAX_ENTRIES) return false;
        const s = join(from, entry.name);
        const t = join(to, entry.name);
        if (entry.isDirectory()) {
          await mkdir(t, { recursive: true });
          if (!(await walk(s, t))) return false;
        } else if (entry.isFile()) {
          try {
            const st = await stat(s);
            if (st.size > MAX_FILE_BYTES || bytes + st.size > MAX_TOTAL_BYTES) return false;
            bytes += st.size;
            await copyFile(s, t);
          } catch (err) {
            if (isSkippable(err)) continue; // unreadable — skip
            throw err;
          }
        } else if (entry.isSymbolicLink()) {
          // copyFile follows symlinks, so a link pointing OUTSIDE the project
          // (e.g. ~/.ssh/config) would leak its content into the fork — the
          // fork must stay self-contained. Resolve the real target and only
          // copy it when it stays inside the source tree.
          try {
            const resolved = await realpath(s);
            const root = resolve(src) + sep;
            if (resolved.startsWith(root) || resolved === resolve(src)) {
              await copyFile(resolved, t);
            }
            // outside the tree: skip (the fork loses the link, not the secret)
          } catch (err) {
            if (isSkippable(err)) continue; // broken link — skip
            throw err;
          }
        }
        // other entry types (fifo, socket, device) are never copied —
        // copying a fifo would block the fork forever
      }
      return true;
    };
    if (!(await walk(src, dest))) {
      await rm(dest, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, error: 'project too large to fork (entry or size budget exceeded)' };
    }
    await writeForkMarker(dest, src);
    return { ok: true, path: dest };
  } catch (err) {
    // never leave a partial fork behind on a failed copy
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: `fork failed: ${(err as Error).message}` };
  }
}
