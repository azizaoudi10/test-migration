import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PromptDraft, PromptEntry } from '../src/shared/ipc.js';
import { sanitizePromptText } from '../src/shared/sanitize.js';
import { SerialQueue } from './serial-queue.js';

/** Caps: the library is personal text, not a database. */
export const MAX_PROMPTS = 500;
export const MAX_PROMPT_NAME = 120;
export const MAX_PROMPT_BODY = 4000;
export const MAX_PROMPT_TAGS = 12;
export const MAX_PROMPT_TAG = 32;

export interface PromptFile {
  version: 1;
  prompts: PromptEntry[];
  exportedAt?: number;
}

function clampString(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const tag = t.trim().slice(0, MAX_PROMPT_TAG);
    if (tag.length === 0 || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= MAX_PROMPT_TAGS) break;
  }
  return out;
}

function normalizeEntry(raw: unknown): PromptEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string' || e.id.length === 0) return null;
  return {
    id: e.id.slice(0, 64),
    name: clampString(e.name, MAX_PROMPT_NAME),
    body: clampString(e.body, MAX_PROMPT_BODY),
    tags: normalizeTags(e.tags),
    createdAt: typeof e.createdAt === 'number' ? e.createdAt : Date.now(),
    updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : Date.now(),
    useCount: typeof e.useCount === 'number' && e.useCount >= 0 ? Math.floor(e.useCount) : 0,
    lastUsedAt: typeof e.lastUsedAt === 'number' ? e.lastUsedAt : null,
  };
}

/**
 * The global Prompt Store (userData/prompts.json): save/re-find prompts sent
 * to the reviewer harness. Bodies are sanitized on save (emoji/bidi/control
 * stripped, newlines preserved — audit decision D11). Writes are serialized,
 * atomic (tmp+rename) and capped; a corrupt file is quarantined, never
 * silently overwritten.
 */
export class PromptStore {
  constructor(private readonly file: string) {}

  private readonly mutex = new SerialQueue();
  private cache: PromptEntry[] | null = null;

  async list(): Promise<PromptEntry[]> {
    if (this.cache !== null) return this.cache;
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      this.cache = [];
      return this.cache;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PromptFile>;
      const prompts = Array.isArray(parsed.prompts)
        ? parsed.prompts.map(normalizeEntry).filter((e): e is PromptEntry => e !== null)
        : [];
      this.cache = prompts.slice(0, MAX_PROMPTS);
      return this.cache;
    } catch {
      // corrupt JSON: keep the blob for forensics, start clean
      await rename(this.file, `${this.file}.bad-${Date.now()}`).catch(() => undefined);
      this.cache = [];
      return this.cache;
    }
  }

  /** Creates (draft.id unset) or updates an entry. Sanitizes name/body/tags
   *  and enforces every cap; counters are server-owned. */
  save(draft: PromptDraft): Promise<PromptEntry> {
    return this.mutex.run(async () => {
      const current = await this.list();
      const now = Date.now();
      const existing = typeof draft.id === 'string' ? current.find((e) => e.id === draft.id) : undefined;
      const entry: PromptEntry = {
        id: existing?.id ?? `pr-${randomUUID()}`,
        name: sanitizePromptText(clampString(draft.name, MAX_PROMPT_NAME)).trim() || 'untitled prompt',
        body: sanitizePromptText(clampString(draft.body, MAX_PROMPT_BODY)),
        tags: normalizeTags(draft.tags),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        useCount: existing?.useCount ?? 0,
        lastUsedAt: existing?.lastUsedAt ?? null,
      };
      const next = existing !== undefined ? current.map((e) => (e.id === entry.id ? entry : e)) : [entry, ...current];
      await this.persist(next.slice(0, MAX_PROMPTS));
      return entry;
    });
  }

  delete(id: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const current = await this.list();
      const next = current.filter((e) => e.id !== id);
      if (next.length === current.length) return false;
      await this.persist(next);
      return true;
    });
  }

  /** Records a use and returns the entry (the caller expands variables). */
  use(id: string): Promise<PromptEntry | null> {
    return this.mutex.run(async () => {
      const current = await this.list();
      const existing = current.find((e) => e.id === id);
      if (existing === undefined) return null;
      const updated: PromptEntry = { ...existing, useCount: existing.useCount + 1, lastUsedAt: Date.now() };
      await this.persist(current.map((e) => (e.id === id ? updated : e)));
      return updated;
    });
  }

  async exportPrompts(): Promise<string> {
    const prompts = await this.list();
    return JSON.stringify({ version: 1, exportedAt: Date.now(), prompts });
  }

  async importPrompts(json: string): Promise<{ imported: number; errors: string[] }> {
    const errors: string[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { imported: 0, errors: ['invalid JSON'] };
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>).prompts)) {
      return { imported: 0, errors: ['missing or invalid prompts array'] };
    }
    const data = parsed as Record<string, unknown>;
    const rawPrompts = data.prompts as unknown[];
    const current = await this.list();
    const next = [...current];
    let imported = 0;
    for (const raw of rawPrompts) {
      const entry = normalizeEntry(raw);
      if (entry === null) {
        errors.push('skipped invalid entry');
        continue;
      }
      const existing = next.find((e) => e.id === entry.id);
      if (existing !== undefined) {
        errors.push(`skipped duplicate id ${entry.id}`);
        continue;
      }
      next.push(entry);
      imported++;
    }
    await this.persist(next.slice(0, MAX_PROMPTS));
    return { imported, errors };
  }

  private async persist(entries: PromptEntry[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, prompts: entries } satisfies PromptFile, null, 2), 'utf8');
    await rename(tmp, this.file);
    this.cache = entries;
  }
}
