import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globToRe, runSearch } from '../electron/reviewer-search.js';

describe('reviewer search engine (audit C6/RV-09)', () => {
  it('rejects nested-quantifier patterns before any engine runs', async () => {
    const out = await runSearch({ pattern: '(a+)+$', abs: '/tmp', maxMatches: 10, display: 'x' });
    expect(out).toContain('unsafe pattern');
  });

  it('brace globs match alternations', () => {
    const re = new RegExp(globToRe('*.{ts,txt}'));
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('a.txt')).toBe(true);
    expect(re.test('a.md')).toBe(false);
  });

  it('finds matches and reports no-match distinctly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frak-search-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'const NEEDLE = 1;\n');
    await writeFile(join(root, 'src', 'b.ts'), 'const other = 2;\n');
    const hit = await runSearch({ pattern: 'NEEDLE', abs: root, maxMatches: 10, display: root });
    expect(hit).toContain('a.ts:1');
    const miss = await runSearch({ pattern: 'ZZZ_NONE', abs: root, maxMatches: 10, display: root });
    expect(miss).toBe('(no matches)');
  });
});
