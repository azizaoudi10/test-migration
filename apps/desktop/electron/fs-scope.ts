import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Renderer-supplied paths are untrusted: the renderer process runs web
 * content, so every fs-adjacent IPC handler confines its arguments to the
 * registered project roots (the only scope the app's own UI ever uses).
 *
 * Two checks per path:
 *  1. lexical — resolve() and require it to sit under some root;
 *  2. symlink — realpath() the existing prefix of the path and require the
 *     resolved target to still sit under a (realpath'd) root, so a symlink
 *     planted inside a project cannot smuggle reads/writes outside it.
 */

function normalizeRoot(root: string): string {
  const r = resolve(root);
  return r.endsWith(sep) && r.length > sep.length ? r.slice(0, -1) : r;
}

/** realpath of the deepest existing ancestor of `p`, plus the not-yet-existing remainder. */
async function realPrefix(p: string): Promise<{ real: string; rest: string; verified: boolean }> {
  let rest = '';
  let cur = resolve(p);
  for (let i = 0; i < 40; i += 1) {
    try {
      return { real: await realpath(cur), rest, verified: true };
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return { real: cur, rest, verified: false };
      rest = rest.length > 0 ? join(basename(cur), rest) : basename(cur);
      cur = parent;
    }
  }
  // bailing out must fail CLOSED: an unverified prefix must never be
  // treated as confined (audit SEC-FS)
  return { real: cur, rest, verified: false };
}

function under(root: string, p: string): boolean {
  // a registered '/' root covers every absolute path
  if (root === sep) return true;
  return p === root || p.startsWith(root + sep);
}

/**
 * Returns the verified absolute path, or null when `target` escapes every
 * root (lexically or through a symlink). Non-absolute targets are refused —
 * renderer code always sends absolute paths.
 */
export async function confinePath(roots: string[], target: unknown): Promise<string | null> {
  if (typeof target !== 'string' || target.length === 0 || target.length > 4096 || !isAbsolute(target)) return null;
  const abs = resolve(target);
  const lexRoots = roots.map(normalizeRoot);
  if (lexRoots.some((r) => under(r, abs))) {
    // lexical hit — but a path component may still be a symlink out; verify
    // via realpath of the existing prefix
    const { real, rest, verified } = await realPrefix(abs);
    if (!verified) return null;
    const realRoots = await Promise.all(lexRoots.map((r) => realpath(r).catch(() => r)));
    if (realRoots.some((r) => under(normalizeRoot(r), real)) && (rest.length === 0 || realRoots.some((r) => under(normalizeRoot(r), join(real, rest))))) {
      return join(real, rest);
    }
    return null;
  }
  return null;
}

/**
 * Stricter confinement for WRITE-like operations: rejects any existing
 * symlink component so a link swapped in between the check and the
 * operation cannot redirect the write outside the roots (TOCTOU mitigation,
 * audit SEC-5).
 */
export async function confineNoSymlinks(roots: string[], target: unknown): Promise<string | null> {
  const scoped = await confinePath(roots, target);
  if (scoped === null) return null;
  const parts = scoped.split(sep).filter((p) => p.length > 0);
  let cur: string = sep;
  for (const part of parts) {
    cur = join(cur, part);
    try {
      const st = await lstat(cur);
      if (st.isSymbolicLink()) return null;
    } catch {
      // the rest of the path does not exist yet — nothing more to check
      break;
    }
  }
  return scoped;
}

/** True when `target` is one of the roots themselves or a path under one. */
export async function confineDir(roots: string[], target: unknown): Promise<string | null> {
  const p = await confinePath(roots, target);
  if (p === null) return null;
  return p;
}

export class PathOutsideScopeError extends Error {
  constructor() {
    super('path is outside the registered projects');
    this.name = 'PathOutsideScopeError';
  }
}

/** confinePath that throws the canonical user-facing error. */
export async function confineOrThrow(roots: string[], target: unknown): Promise<string> {
  const p = await confinePath(roots, target);
  if (p === null) throw new PathOutsideScopeError();
  return p;
}
