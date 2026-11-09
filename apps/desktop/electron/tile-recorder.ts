/** In-memory per-tile terminal recordings: the harness's live view of every
 *  agent. Each PTY chunk is fed into a real terminal emulator (TileEmulator,
 *  @xterm/headless) that commits clean lines the way the user's actual
 *  terminal would — full-screen TUIs like opencode collapse into readable
 *  lines instead of merging overwritten text, and alternate-screen frames
 *  never leak into scrollback. Committed lines are kept in a bounded ring;
 *  the on-disk scrollback files (written by scrollback-persist) mirror the
 *  ring plus the emulator's live viewport. No writes happen on the ptyData
 *  hot path beyond the in-memory ring. */

import { TileEmulator } from './tile-emulator.js';

/** App-wide recorded-line budget across every tile (~64MB of typical text);
 *  per-tile rings remain the first bound, this is the session-wide backstop. */
const MAX_TOTAL_LINES = 200_000;

// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-9;?]*[- /]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const TWO_BYTE_RE = /\x1b[()#%=>][0-9A-Za-z]?/g;

/** Strips all ANSI/OSC/charset escapes from a string (color and cursor alike).
 *  Kept as a general utility; the recorder itself emulates TUI escapes via
 *  TileEmulator instead of deleting them. */
export function stripAnsi(text: string): string {
  return text.replace(OSC_RE, '').replace(CSI_RE, '').replace(TWO_BYTE_RE, '');
}

export interface TileRecorderOpts {
  /** Ring size per tile. */
  maxLines?: number;
  /** Per-line cap; longer lines are truncated with a marker. */
  maxLineLen?: number;
  /** App-wide line budget across every tile (default MAX_TOTAL_LINES). */
  maxTotalLines?: number;
  /** Diagnostics sink (main's logger). */
  logger?: (line: string) => void;
}

export class TileRecorder {
  private readonly maxLines: number;
  private readonly maxLineLen: number;
  private readonly logger: ((line: string) => void) | undefined;
  private readonly buffers = new Map<string, string[]>();
  private readonly emulators = new Map<string, TileEmulator>();
  private readonly lastAt = new Map<string, number>();
  /** Latest PTY size per tile: the emulator is created lazily on the first
   *  chunk, so the size must be retained before that (audit PTY-01). */
  private readonly sizes = new Map<string, { cols: number; rows: number }>();
  /** Global line budget across every tile — per-tile rings are bounded, but
   *  a large session could still accumulate hundreds of MB (audit PTY-34). */
  private readonly maxTotalLines: number;
  private totalLines = 0;
  /** Tiles whose emulator threw — chunk data is skipped rather than letting
   *  a throw escape onto the PTY output path. Transient failures retry a
   *  bounded number of times before the tile is permanently muted. */
  private readonly broken = new Set<string>();
  private readonly failures = new Map<string, number>();

  constructor(opts: TileRecorderOpts = {}) {
    this.maxLines = opts.maxLines ?? 5000;
    this.maxLineLen = opts.maxLineLen ?? 4096;
    this.maxTotalLines = opts.maxTotalLines ?? MAX_TOTAL_LINES;
    this.logger = opts.logger;
  }

  /** Feeds one ptyData chunk into the tile's recording. Never throws: the
   *  headless emulator sits on the PTY output hot path (inside a
   *  setImmediate flush), so a throw here would stall output for every
   *  tile of the session — the chunk is dropped instead. */
  record(tileId: string, chunk: string): void {
    try {
      this.recordInner(tileId, chunk);
      this.failures.delete(tileId);
    } catch (err) {
      this.logger?.(`tile-recorder: emulator failed for ${tileId} (${(err as Error).message})`);
      this.emulators.get(tileId)?.dispose();
      this.emulators.delete(tileId);
      const failures = (this.failures.get(tileId) ?? 0) + 1;
      this.failures.set(tileId, failures);
      if (failures >= 3) this.broken.add(tileId);
    }
  }

  private recordInner(tileId: string, chunk: string): void {
    if (this.broken.has(tileId)) return;
    let emu = this.emulators.get(tileId);
    if (!emu) {
      const size = this.sizes.get(tileId);
      emu = new TileEmulator(size?.cols, size?.rows, this.maxLines);
      this.emulators.set(tileId, emu);
    }
    for (const line of emu.push(chunk)) this.append(tileId, line);
    this.lastAt.set(tileId, Date.now());
  }

  /** Syncs the tile's emulator size with its PTY (renderer resize events).
   *  The size is retained even before the emulator exists. */
  resize(tileId: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.sizes.set(tileId, { cols, rows });
    this.emulators.get(tileId)?.resize(cols, rows);
  }

  has(tileId: string): boolean {
    const bufLen = this.buffers.get(tileId)?.length ?? 0;
    const live = this.emulators.get(tileId)?.viewportLines().length ?? 0;
    return bufLen > 0 || live > 0;
  }

  /** The last `n` lines of the tile, including the emulator's live viewport
   *  (the on-screen picture a real terminal shows — the reviewer must see it). */
  tail(tileId: string, n: number): string[] {
    const withLive = this.withLive(tileId);
    return withLive.slice(Math.max(0, withLive.length - n));
  }

  /** The ENTIRE recording of the tile (every buffered line plus the live
   *  viewport) — the full picture for the reviewer, not a tail. */
  full(tileId: string): string[] {
    return this.withLive(tileId);
  }

  /** Lines matching `re` (reset between tests so /g flags are safe). */
  search(tileId: string, re: RegExp, limit = 50): string[] {
    const out: string[] = [];
    for (const line of this.withLive(tileId)) {
      re.lastIndex = 0;
      if (re.test(line)) {
        out.push(line);
        if (out.length >= limit) break;
      }
    }
    re.lastIndex = 0;
    return out;
  }

  summary(tileId: string): { lines: number; lastAt: number } {
    const ring = this.buffers.get(tileId)?.length ?? 0;
    const live = this.emulators.get(tileId)?.viewportLines().length ?? 0;
    return {
      lines: ring + live,
      lastAt: this.lastAt.get(tileId) ?? 0,
    };
  }

  /** Every tile with recorded content, keyed by tileId. Tiles whose output
   *  lives only in the emulator viewport (no committed lines yet) count —
   *  the loop carrier's activity delta and list_tiles both depend on it. */
  list(): Map<string, { lines: number; lastAt: number }> {
    const out = new Map<string, { lines: number; lastAt: number }>();
    const ids = new Set([...this.buffers.keys(), ...this.emulators.keys()]);
    for (const tileId of ids) {
      if (this.has(tileId)) {
        out.set(tileId, this.summary(tileId));
      }
    }
    return out;
  }

  /** Releases all state for a tile (its PTY exited or the tile was pruned)
   *  so long-lived sessions do not accumulate per-tile memory forever. The
   *  failure/broken marks reset too: tile ids are reused across sessions and
   *  a transient parser failure must not mute the id forever (audit PTY-07). */
  drop(tileId: string): void {
    this.totalLines -= this.buffers.get(tileId)?.length ?? 0;
    this.buffers.delete(tileId);
    this.emulators.get(tileId)?.dispose();
    this.emulators.delete(tileId);
    this.lastAt.delete(tileId);
    this.sizes.delete(tileId);
    this.broken.delete(tileId);
    this.failures.delete(tileId);
  }

  private withLive(tileId: string): string[] {
    const lines = this.buffers.get(tileId) ?? [];
    const viewport = (this.emulators.get(tileId)?.viewportLines() ?? []).map((l) =>
      l.length > this.maxLineLen ? `${l.slice(0, this.maxLineLen)}\u2026[truncated]` : l,
    );
    return [...lines, ...viewport];
  }

  private append(tileId: string, line: string): void {
    let buf = this.buffers.get(tileId);
    if (!buf) {
      buf = [];
      this.buffers.set(tileId, buf);
    }
    if (line.length > this.maxLineLen) {
      line = `${line.slice(0, this.maxLineLen)}\u2026[truncated]`;
    }
    buf.push(line);
    this.totalLines += 1;
    if (buf.length > this.maxLines) {
      const removed = buf.length - this.maxLines;
      buf.splice(0, removed);
      this.totalLines -= removed;
    }
    this.evictOverBudget(tileId);
  }

  /** Caps the global line count by halving the oldest untouched tile's ring
   *  when the app-wide budget is exceeded. The current tile is never the
   *  victim: the reviewer is reading it right now. */
  private evictOverBudget(current: string): void {
    while (this.totalLines > this.maxTotalLines) {
      let victim: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [id, buf] of this.buffers) {
        if (id === current || buf.length === 0) continue;
        const at = this.lastAt.get(id) ?? 0;
        if (at < oldest) {
          oldest = at;
          victim = id;
        }
      }
      if (victim === null) return;
      const buf = this.buffers.get(victim)!;
      const remove = Math.max(1, Math.floor(buf.length / 2));
      buf.splice(0, remove);
      this.totalLines -= remove;
      this.logger?.(`tile-recorder: evicted ${remove} lines from ${victim} (global budget)`);
    }
  }
}
