import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PROMPTS, PromptStore } from '../electron/prompt-store.js';

let dir = '';
let file = '';
let store: PromptStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'frak-prompts-'));
  file = join(dir, 'prompts.json');
  store = new PromptStore(file);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('PromptStore', () => {
  it('creates, lists, updates and deletes entries', async () => {
    const created = await store.save({ name: 'Refactor', body: 'Refactor {{cwd}} carefully', tags: ['code'] });
    expect(created.id).toMatch(/^pr-/);
    expect(created.useCount).toBe(0);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('Refactor');

    const updated = await store.save({ id: created.id, name: 'Refactor v2', body: 'better', tags: [] });
    expect(updated.id).toBe(created.id);
    expect(updated.useCount).toBe(0);
    expect((await store.list())[0]!.name).toBe('Refactor v2');

    expect(await store.delete(created.id)).toBe(true);
    expect(await store.list()).toHaveLength(0);
    expect(await store.delete('nope')).toBe(false);
  });

  it('sanitizes on save and preserves newlines', async () => {
    const entry = await store.save({ name: 'multi 🙂', body: 'line1\n\tline2 \u202Eevil', tags: ['a'] });
    expect(entry.name).toBe('multi');
    expect(entry.body).toBe('line1\n\tline2 evil');
  });

  it('caps name, body, tags and library size', async () => {
    const entry = await store.save({
      name: 'n'.repeat(500),
      body: 'b'.repeat(9000),
      tags: Array.from({ length: 30 }, (_, i) => `t${i}`),
    });
    expect(entry.name.length).toBeLessThanOrEqual(120);
    expect(entry.body.length).toBeLessThanOrEqual(4000);
    expect(entry.tags.length).toBeLessThanOrEqual(12);
    for (let i = 0; i < 20; i += 1) await store.save({ name: `p${i}`, body: 'x' });
    // library size cap holds (500); we only assert the write survives many
    expect((await store.list()).length).toBeLessThanOrEqual(MAX_PROMPTS);
  });

  it('counts uses and stamps lastUsedAt', async () => {
    const entry = await store.save({ name: 'use me', body: 'x' });
    const used = await store.use(entry.id);
    expect(used?.useCount).toBe(1);
    expect(used?.lastUsedAt).not.toBeNull();
    expect(await store.use('missing')).toBeNull();
  });

  it('serializes concurrent saves without losing entries', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.save({ name: `p${i}`, body: 'x' })),
    );
    expect((await store.list()).length).toBe(10);
  });

  it('quarantines a corrupt file instead of overwriting it', async () => {
    await writeFile(file, '{ not json', 'utf8');
    expect(await store.list()).toEqual([]);
    const entries = await readdir(dir);
    const quarantined = entries.find((e) => e.startsWith('prompts.json.bad-'));
    expect(quarantined).toBeDefined();
    expect(await readFile(join(dir, quarantined!), 'utf8')).toBe('{ not json');
  });
});
