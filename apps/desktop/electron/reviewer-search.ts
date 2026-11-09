import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * The reviewer's file search engine, isolated from the main process.
 *
 * A model-supplied regex is untrusted input: catastrophic backtracking
 * (e.g. `(a|a)+$`) can freeze the whole app when executed synchronously in
 * the main process. This module is therefore executed inside a worker thread
 * (electron/search-worker.ts) under a hard timeout by reviewer-tools, and
 * only falls back to in-process execution when the worker bundle is absent
 * (unit tests).
 */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.fraktole-auto', '.next', '.cache']);
const SEARCH_SCAN_CAP = 5_000;
const SEARCH_LINE_CAP = 200;
const SEARCH_LINE_TEST_CAP = 4096;
const TOOL_RESULT_CAP = 20_000;

export interface SearchRequest {
  pattern: string;
  abs: string;
  glob?: string;
  maxMatches: number;
  display: string;
}

/** Nested-quantifier patterns are the classic catastrophic-backtracking
 *  signature — reject them outright before any engine runs. */
const RE_UNSAFE = /\([^()]*[+*?][^()]*\)[+*?]/;

function capResult(text: string): string {
  if (text.length <= TOOL_RESULT_CAP) return text;
  return `${text.slice(0, TOOL_RESULT_CAP)}\n...[truncated]`;
}

/** Brace alternation: `*.{ts,tsx}` must match both extensions — escaping the
 *  braces made the advertised filter match nothing (audit RV-09). */
/** Relative paths shown to the model always use '/', whatever the OS: on
 *  Windows path.relative() yields 'src\\app.ts', which the model would then
 *  echo back inconsistently (and tool output must not depend on the host). */
export function toPosixRel(rel: string): string {
  return sep === '/' ? rel : rel.split(sep).join('/');
}

export function globToRe(glob: string): string {
  const brace = /\{([^{}]*)\}/.exec(glob);
  if (brace) {
    const alternatives = brace[1]!
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    if (alternatives.length > 0) {
      const expanded = alternatives.map(
        (alt) => glob.slice(0, brace.index) + alt + glob.slice(brace.index + brace[0].length),
      );
      return `^(?:${expanded.map((g) => globToRe(g).slice(1, -1)).join('|')})$`;
    }
  }
  let out = '^';
  for (const ch of glob) {
    if (ch === '*') {
      out += '.*';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return `${out}$`;
}

export async function runSearch(req: SearchRequest): Promise<string> {
  const { pattern, abs, glob, maxMatches, display } = req;
  if (RE_UNSAFE.test(pattern)) return 'error: bad regex: unsafe pattern (nested quantifiers)';
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    return `error: bad regex: ${String(err)}`;
  }
  // stat first: a FILE path must search that single file (never silently
  // match nothing), and a missing path must error loudly instead of reading
  // as a false "(no matches)"
  let st;
  try {
    st = await stat(abs);
  } catch {
    return `error: path not found: ${display}`;
  }
  if (st.isFile()) return searchSingleFile(re, abs, display, maxMatches);
  if (!st.isDirectory()) return `error: path is not a file or directory: ${display}`;
  const fileRe = glob !== undefined ? new RegExp(globToRe(glob)) : null;
  const hits: string[] = [];
  let scanned = 0;
  const walk = async (dir: string, remaining: number): Promise<void> => {
    if (hits.length >= maxMatches || scanned >= SEARCH_SCAN_CAP) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= maxMatches || scanned >= SEARCH_SCAN_CAP) return;
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (remaining > 1 && SKIP_DIRS.has(e.name)) continue;
        if (remaining > 1) await walk(full, remaining - 1);
      } else {
        if (fileRe && !fileRe.test(e.name)) continue;
        scanned += 1;
        try {
          const fileStat = await stat(full);
          if (fileStat.size > 2 * 1024 * 1024) continue; // skip big/binary files
          const content = await readFile(full, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && hits.length < maxMatches; i++) {
            const line = lines[i]!;
            // test a capped slice: a pathological pattern against a huge
            // single line must not hang the search engine
            if (re.test(line.slice(0, SEARCH_LINE_TEST_CAP))) {
              hits.push(`${toPosixRel(relative(abs, full))}:${i + 1}: ${line.slice(0, SEARCH_LINE_CAP)}`);
            }
          }
        } catch {
          // unreadable — skip
        }
      }
    }
  };
  await walk(abs, 12);
  if (hits.length === 0) return '(no matches)';
  const note = scanned >= SEARCH_SCAN_CAP ? '\n…[scan cap reached]' : '';
  return `${capResult(hits.join('\n'))}${note}`;
}

/** Searches a single file (search_files given a file path). Hits are prefixed
 *  with the caller's `display` path so the model can map them back. */
async function searchSingleFile(
  re: RegExp,
  file: string,
  display: string,
  maxMatches: number,
): Promise<string> {
  try {
    const st = await stat(file);
    if (st.size > 2 * 1024 * 1024) return 'error: file larger than 2 MiB — use read_file';
    const content = await readFile(file, 'utf8');
    const lines = content.split('\n');
    const hits: string[] = [];
    for (let i = 0; i < lines.length && hits.length < maxMatches; i++) {
      const line = lines[i]!;
      if (re.test(line.slice(0, SEARCH_LINE_TEST_CAP))) {
        hits.push(`${display}:${i + 1}: ${line.slice(0, SEARCH_LINE_CAP)}`);
      }
    }
    return hits.length > 0 ? capResult(hits.join('\n')) : '(no matches)';
  } catch (err) {
    return `error: ${(err as NodeJS.ErrnoException).message}`;
  }
}
