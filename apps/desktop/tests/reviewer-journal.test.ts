import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewerJournal } from '../electron/reviewer-journal.js';

const msg = (content: string, extra: Record<string, unknown> = {}) => ({
  at: Date.now(),
  kind: 'msg' as const,
  msg: { role: 'user' as const, content, ...extra },
});

describe('ReviewerJournal', () => {
  it('round-trips messages with thinking traces and strips the volatile announced flag', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frak-journal-'));
    const journal = new ReviewerJournal(join(dir, 'reviewer'));
    await journal.append([
      msg('hello', { announced: true }),
      { at: Date.now(), kind: 'msg', msg: { role: 'assistant', content: 'hi', thinking: 'chain of thought here' } },
    ]);
    const entries = await journal.read();
    expect(entries.length).toBe(2);
    expect(entries[0]).toMatchObject({ kind: 'msg' });
    expect((entries[0] as { msg: { announced?: boolean } }).msg.announced).toBeUndefined();
    const assistant = entries[1] as { msg: { thinking?: string } };
    expect(assistant.msg.thinking).toBe('chain of thought here');
    // raw file keeps one JSON object per line
    const raw = await readFile(join(dir, 'reviewer', 'journal.jsonl'), 'utf8');
    expect(raw.trim().split('\n').length).toBe(2);
  });

  it('skips corrupt lines and invalid entries without hiding the rest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frak-journal-'));
    const journal = new ReviewerJournal(join(dir, 'reviewer'));
    await journal.append(msg('first'));
    const { appendFile } = await import('node:fs/promises');
    await appendFile(journal.file, 'not-json\n{"kind":"msg"}\n{"at":"x","kind":"msg","msg":{}}\n', 'utf8');
    await journal.append(msg('second'));
    const entries = await journal.read();
    expect(entries.map((e) => (e.kind === 'msg' ? e.msg.content : e.kind))).toEqual(['first', 'second']);
  });

  it('liveWindow replays only the messages after the last reset marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frak-journal-'));
    const journal = new ReviewerJournal(join(dir, 'reviewer'));
    await journal.append([msg('old-1'), msg('old-2')]);
    await journal.append({ at: Date.now(), kind: 'compact', droppedMsgs: 2, forced: true });
    await journal.append(msg('note'));
    await journal.append(msg('new-1'));
    await journal.append({ at: Date.now(), kind: 'big-compact' });
    await journal.append(msg('recap'));
    expect((await journal.liveWindow()).map((m) => m.content)).toEqual(['recap']);
  });

  it('a truncate marker wipes the live window (restart starts blank)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frak-journal-'));
    const journal = new ReviewerJournal(join(dir, 'reviewer'));
    await journal.append(msg('before-restart'));
    await journal.append({ at: Date.now(), kind: 'truncate' });
    expect(await journal.liveWindow()).toEqual([]);
  });

  it('read on a missing journal returns empty (fresh session)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frak-journal-'));
    const journal = new ReviewerJournal(join(dir, 'reviewer'));
    expect(await journal.read()).toEqual([]);
    expect(await journal.liveWindow()).toEqual([]);
  });

  it('serializes concurrent appends in call order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frak-journal-'));
    const journal = new ReviewerJournal(join(dir, 'reviewer'));
    await Promise.all([journal.append(msg('a')), journal.append(msg('b')), journal.append(msg('c'))]);
    expect((await journal.liveWindow()).map((m) => m.content)).toEqual(['a', 'b', 'c']);
  });
});

describe('journal validation + rotation (audit RV-E17/RV-26)', () => {
  it('drops malformed msg entries from recovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frak-journal-bad-'));
    const file = join(dir, 'reviewer', 'journal.jsonl');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(dir, 'reviewer'), { recursive: true });
    await writeFile(
      file,
      [
        JSON.stringify({ at: 1, kind: 'msg', msg: {} }),
        JSON.stringify({ at: 2, kind: 'msg', msg: { role: 7, content: 'x' } }),
        JSON.stringify(msg('valid')),
      ].join('\n') + '\n',
      'utf8',
    );
    const journal = new ReviewerJournal(join(dir, 'reviewer'));
    const entries = await journal.read();
    expect(entries).toHaveLength(1);
    expect((entries[0] as { msg: { content: string } }).msg.content).toBe('valid');
  });

  it('rotates an oversized journal to its tail, starting at a marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frak-journal-rot-'));
    const journal = new ReviewerJournal(join(dir, 'reviewer'));
    await journal.append({ at: 1, kind: 'truncate' });
    const bulk = Array.from({ length: 20_001 }, (_, i) => msg(`m${i}`));
    await journal.append(bulk);
    const entries = await journal.read();
    expect(entries.length).toBeLessThanOrEqual(4_001);
    expect(entries[0]!.kind).not.toBe('msg'); // recovery boundary preserved
    expect((entries[entries.length - 1] as { msg: { content: string } }).msg.content).toBe('m20000');
  });
});
