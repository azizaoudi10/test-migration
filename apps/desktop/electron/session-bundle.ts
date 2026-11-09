import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionFile } from '../src/shared/ipc.js';
import { newSessionId, touchSessionIndex } from './sessions.js';
import { tarBinary } from './platform.js';

/** Post-extraction safety walk: rejects any symlink that materialised (the
 *  pre-scan can be bypassed by a TOCTOU archive swap — audit PTY-36). */
async function walkForUnsafe(root: string): Promise<string | null> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) return `invalid bundle: symlink extracted (${e.name})`;
      if (e.isDirectory()) stack.push(join(dir, e.name));
    }
  }
  return null;
}

export type BundleResult =
  | { ok: true; path?: string; session?: SessionFile }
  | { ok: false; canceled?: boolean; error: string };

/** Upper bound for an importable bundle — protects the main process from a
 *  multi-GB archive before extraction even starts. */
export const MAX_BUNDLE_BYTES = 500 * 1024 * 1024;
/** Post-extraction bounds (zip bombs: the compressed size says nothing). */
export const MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_BUNDLE_ENTRIES = 100_000;

function execFileP(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).slice(0, 300)));
      else resolve(stdout);
    });
  });
}

/** Size column of one `tar -tv` row. GNU tar prints
 *  `mode owner/group size date …`; bsdtar (Windows' System32\tar.exe,
 *  macOS) prints `mode links owner group size date …`. */
export function tarVerboseSize(row: string): number | null {
  const r = row.trim();
  const gnu = /^\S+\s+\S+\/\S+\s+(\d+)\s/.exec(r);
  if (gnu) return Number(gnu[1]);
  const bsd = /^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s/.exec(r);
  if (bsd) return Number(bsd[1]);
  return null;
}

/** Packages a session folder as a tar.gz (tar is POSIX core, and ships as
 *  bsdtar in Windows 10 1803+). The archive contains the session dir with its id as the single
 *  top-level folder — the exact shape importSessionBundle expects. */
export async function exportSessionBundle(sessionsRoot: string, id: string, dest: string): Promise<BundleResult> {
  // the id reaches stat() and tar argv — only internally-generated ids may
  // be exported (no traversal, no absolute paths, no tar option injection)
  if (!/^s-[a-z0-9-]+$/.test(id)) return { ok: false, error: 'invalid session id' };
  try {
    await stat(join(sessionsRoot, id));
    // archive to a tmp file first: a mid-stream failure must not leave a
    // partial .tar.gz at the user-chosen destination (and the tmp is
    // removed on failure — audit PTY-35)
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    try {
      await execFileP(tarBinary(), ['-czf', tmp, '-C', sessionsRoot, id]);
      await rename(tmp, dest);
      return { ok: true, path: dest };
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    return { ok: false, error: `export failed: ${(err as Error).message}` };
  }
}

/** Validates a bundle and installs it as a NEW session (re-keyed with a
 *  fresh id — importing never overwrites an existing session). The bundle
 *  must be a tar.gz whose single top-level folder holds a valid
 *  session.json; everything else (reviewer conversation, scrollbacks,
 *  mailboxes) is carried over as-is and picked up by the runtime. */
export async function importSessionBundle(sessionsRoot: string, bundleFile: string): Promise<BundleResult> {
  const tmp = join(sessionsRoot, `.import-${Math.random().toString(36).slice(2, 8)}`);
  try {
    const st = await stat(bundleFile);
    if (st.size > MAX_BUNDLE_BYTES) {
      return { ok: false, error: `bundle too large (${(st.size / 1024 / 1024).toFixed(0)} MB, cap 500 MB)` };
    }
    const listing = (await execFileP(tarBinary(), ['-tzf', bundleFile])).split(/\r?\n/).filter((l) => l.length > 0);
    if (listing.length === 0) return { ok: false, error: 'invalid bundle: empty archive' };
    if (listing.length > MAX_BUNDLE_ENTRIES) {
      return { ok: false, error: `invalid bundle: too many entries (${listing.length}, cap ${MAX_BUNDLE_ENTRIES})` };
    }
    // link members must be rejected BEFORE extraction: GNU tar follows
    // archive-provided symlinks, so `link -> /home/x` + `link/.bashrc`
    // would write outside the extraction dir (zip-slip via links)
    const verbose = (await execFileP(tarBinary(), ['-tvzf', bundleFile])).split(/\r?\n/);
    let unpackedBytes = 0;
    for (const row of verbose) {
      if (/^[lh]/.test(row.trim())) {
        return { ok: false, error: 'invalid bundle: link members are not allowed' };
      }
      // sum the size column BEFORE extracting: a small gzip can expand to
      // terabytes (zip bomb) — reject it while nothing is on disk yet
      const size = tarVerboseSize(row);
      if (size !== null) unpackedBytes += size;
      if (unpackedBytes > MAX_UNPACKED_BYTES) {
        return { ok: false, error: 'invalid bundle: unpacked size exceeds the 2 GB cap' };
      }
    }
    for (const entry of listing) {
      // absolute (POSIX '/x', Windows 'C:x' / '\\x') or traversing members
      if (entry.startsWith('/') || entry.includes('\\') || /^[a-zA-Z]:/.test(entry) || entry.split('/').includes('..')) {
        return { ok: false, error: 'invalid bundle: unsafe path in archive' };
      }
    }
    const topDirs = new Set(listing.map((f) => f.split('/')[0]));
    if (topDirs.size !== 1) return { ok: false, error: 'invalid bundle: expected a single session folder' };
    const topDir = [...topDirs][0]!;
    if (!listing.includes(`${topDir}/session.json`)) return { ok: false, error: 'invalid bundle: session.json missing' };

    await mkdir(tmp, { recursive: true });
    await execFileP(tarBinary(), ['--no-same-owner', '--no-same-permissions', '-xzf', bundleFile, '-C', tmp]);
    const src = join(tmp, topDir);
    // post-extraction re-validation: the pre-scan and the extraction are
    // separate reads of the archive (TOCTOU) — verify nothing outside the
    // single top folder materialised and no link slipped through
    const extracted = await walkForUnsafe(tmp);
    if (extracted !== null) return { ok: false, error: extracted };

    const raw = await readFile(join(src, 'session.json'), 'utf8');
    const session = JSON.parse(raw) as SessionFile;
    if (
      session.version !== 1 ||
      typeof session.id !== 'string' ||
      typeof session.name !== 'string' ||
      !Array.isArray(session.tiles) ||
      typeof session.nextAgentSeq !== 'number'
    ) {
      throw new Error('unsupported session format in bundle');
    }
    // re-key: the imported session must never collide with an existing id.
    // Imported path state is untrusted: the project binding and judge cwd
    // are cleared so the import can never point the app at foreign paths
    // (audit PTY-32)
    const reKeyed: SessionFile = {
      ...session,
      id: newSessionId(),
      updatedAt: Date.now(),
      projectPath: undefined,
      judge: null,
    };
    await writeFile(join(src, 'session.json'), JSON.stringify(reKeyed, null, 2), 'utf8');

    await rename(src, join(sessionsRoot, reKeyed.id));
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    // index the import immediately: without this the session is invisible
    // in the switcher until the renderer's first auto-save (and invisible
    // forever if the app quits first)
    await touchSessionIndex(sessionsRoot, reKeyed).catch(() => undefined);
    return { ok: true, session: reKeyed };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: `import failed: ${(err as Error).message}` };
  }
}
