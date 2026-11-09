import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderMsg } from './reviewer/providers.js';

/** Rotation thresholds: an append-only journal on a long autonomous run
 *  grows without bound and recovery parses the whole file. Past the cap the
 *  file is rewritten to its tail, always starting at a reset marker so
 *  liveWindow() semantics are unchanged. */
const MAX_JOURNAL_ENTRIES = 20_000;
const JOURNAL_RETAIN_ENTRIES = 4_000;

/** Lossless audit log for the reviewer conversation, living next to the
 *  operational transcript (<dir>/journal.jsonl — same dir that holds
 *  conversation.jsonl, state.json and usage.jsonl).
 *
 *  The transcript mirrors the model's live context: compactions rewrite it,
 *  so dropped exchanges vanish from disk. The journal is append-only and is
 *  NEVER rewritten — every persisted message lands here first (thinking
 *  traces included), and every context reset leaves a marker. Recovery
 *  replays the messages after the last marker, so a deleted or corrupt
 *  transcript rebuilds instead of starting blank.
 *
 *  Writes never throw (failures are logged); a serialized queue keeps file
 *  order identical to call order. */

export type JournalEntry =
  | { at: number; kind: 'msg'; msg: ProviderMsg }
  | { at: number; kind: 'compact'; droppedMsgs: number; forced: boolean }
  | { at: number; kind: 'big-compact' }
  | { at: number; kind: 'truncate' };

export class ReviewerJournal {
  /** Serializes appends: concurrent persist/compact calls must never
   *  interleave lines out of order (recovery replays file order). */
  private queue: Promise<void> = Promise.resolve();
  /** Approximate on-disk entry count (drives rotation). */
  private approxEntries = 0;

  constructor(
    private readonly dir: string,
    private readonly logger?: (line: string) => void,
  ) {}

  get file(): string {
    return join(this.dir, 'journal.jsonl');
  }

  append(entries: JournalEntry | JournalEntry[]): Promise<void> {
    const list = Array.isArray(entries) ? entries : [entries];
    if (list.length === 0) return Promise.resolve();
    const run = async (): Promise<void> => {
      try {
        await mkdir(this.dir, { recursive: true });
        await appendFile(this.file, `${list.map((e) => JSON.stringify(stripVolatile(e))).join('\n')}\n`, 'utf8');
        this.approxEntries += list.length;
        if (this.approxEntries > MAX_JOURNAL_ENTRIES) await this.rotateNow();
      } catch (err) {
        // the audit log must never break the loop — log and continue
        this.logger?.(`reviewer: journal append failed (${(err as Error).message})`);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Rewrites the journal to its tail, always starting at a non-msg marker
   *  (or a synthetic compact marker) so recovery still replays only the live
   *  window. Runs inside the append queue: no writer can interleave. */
  private async rotateNow(): Promise<void> {
    const entries = await this.read();
    if (entries.length <= MAX_JOURNAL_ENTRIES) return;
    const tailStart = Math.max(0, entries.length - JOURNAL_RETAIN_ENTRIES);
    let marker = -1;
    for (let i = tailStart; i >= 0; i--) {
      if (entries[i]!.kind !== 'msg') {
        marker = i;
        break;
      }
    }
    const kept: JournalEntry[] =
      marker >= tailStart
        ? entries.slice(marker)
        : [{ at: Date.now(), kind: 'compact', droppedMsgs: tailStart, forced: false }, ...entries.slice(tailStart)];
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${kept.map((e) => JSON.stringify(stripVolatile(e))).join('\n')}\n`, 'utf8');
    await rename(tmp, this.file);
    this.approxEntries = kept.length;
    this.logger?.(`reviewer: journal rotated (${entries.length} → ${kept.length} entries)`);
  }

  async read(): Promise<JournalEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return [];
    }
    const out: JournalEntry[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isEntry(parsed)) out.push(parsed);
      } catch {
        // a corrupt line must not hide the rest — same policy as the
        // conversation loader
      }
    }
    return out;
  }

  /** The messages after the last context-reset marker — the live window a
   *  rebuilt transcript must contain. Everything before the last marker was
   *  superseded by a compaction, a big compact or a restart and must NOT be
   *  resurrected (that is exactly what the transcript rewrite prevents). */
  async liveWindow(): Promise<ProviderMsg[]> {
    const entries = await this.read();
    let start = 0;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i]!.kind !== 'msg') start = i + 1;
    }
    const out: ProviderMsg[] = [];
    for (let i = start; i < entries.length; i++) {
      const e = entries[i]!;
      if (e.kind === 'msg') out.push(e.msg);
    }
    return out;
  }
}

/** The `announced` flag is in-memory only (queue-time emit dedup) — it must
 *  never reach disk, mirroring persist()'s stripping. */
function stripVolatile(e: JournalEntry): JournalEntry {
  if (e.kind !== 'msg') return e;
  const { announced: _announced, ...rest } = e.msg;
  return { ...e, msg: rest };
}

function isEntry(v: unknown): v is JournalEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Partial<JournalEntry> & { msg?: unknown };
  if (typeof e.at !== 'number' || !Number.isFinite(e.at)) return false;
  switch (e.kind) {
    case 'msg': {
      // a malformed journal message must never enter the provider request
      // (an undefined role poisons every later turn — audit RV-E17)
      const msg = (e as { msg?: { role?: unknown; content?: unknown } }).msg;
      return (
        typeof msg === 'object' &&
        msg !== null &&
        typeof msg.role === 'string' &&
        typeof msg.content === 'string'
      );
    }
    case 'compact':
      return typeof (e as { droppedMsgs?: unknown }).droppedMsgs === 'number';
    case 'big-compact':
    case 'truncate':
      return true;
    default:
      return false;
  }
}
