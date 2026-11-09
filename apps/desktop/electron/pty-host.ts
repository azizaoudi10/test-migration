import type * as pty from 'node-pty';
import type { PtyExitPayload } from '../src/shared/ipc.js';
import { IPC } from '../src/shared/ipc.js';
import { loadPty } from './preflight.js';

export interface PtySession {
  pid: number;
  cwd: string;
}

export interface PtySpawnOpts {
  cwd: string;
  cols: number;
  rows: number;
  /** Program to run; defaults to $SHELL. The judge spawns a CLI agent here. */
  command?: string;
  args?: string[];
  /** Extra env for the child: the FRAKTOLE_* mailbox contract. */
  envExt?: Record<string, string>;
}

interface PtyHostOpts {
  send: (channel: string, tileId: string, payload: unknown) => void;
}

interface PtySessionEntry {
  pty: pty.IPty;
  cwd: string;
  /** Pending SIGKILL escalation from kill(); cleared when the pty exits. */
  killTimer: NodeJS.Timeout | null;
  /** Resolved when the pty exits (kill()/killAllAndWait await it). */
  exitWaiters: Array<() => void>;
}

/**
 * One PTY per tile. Children are spawned as session leaders by node-pty, so
 * killing the negative pid kills the shell and its whole process group —
 * agents started inside a tile die with it.
 */
export class PtyHost {
  private readonly sessions = new Map<string, PtySessionEntry>();

  constructor(private readonly opts: PtyHostOpts) {}

  spawn(tileId: string, opts: PtySpawnOpts): PtySession {
    // a reused tileId (renderer remount, reviewer respawn) must never leak
    // the previous process group: kill it before overwriting the slot
    // (audit PTY-20)
    const existing = this.sessions.get(tileId);
    if (existing) {
      this.hardKill(existing);
      this.sessions.delete(tileId);
    }
    const ptyMod = loadPty();
    if (!ptyMod) throw new Error('node-pty unavailable');
    // an empty SHELL (common for app-menu/systemd launches) must fall back:
    // `??` would keep '' and pty.spawn('') fails
    const shell = process.env.SHELL || '/bin/bash';
    const term = ptyMod.spawn(opts.command ?? shell, opts.args ?? [], {
      name: 'xterm-256color',
      cols: Math.max(opts.cols, 2),
      rows: Math.max(opts.rows, 2),
      cwd: opts.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        PWD: opts.cwd,
        ...opts.envExt,
      },
    });
    const entry: PtySessionEntry = { pty: term, cwd: opts.cwd, killTimer: null, exitWaiters: [] };
    term.onData((data) => this.opts.send(IPC.ptyData, tileId, data));
    term.onExit(({ exitCode }) => {
      // clear any pending kill escalation so it can never fire against a
      // recycled tileId/pid, and only drop the entry if it is still ours
      if (entry.killTimer !== null) {
        clearTimeout(entry.killTimer);
        entry.killTimer = null;
      }
      const payload: PtyExitPayload = { code: exitCode };
      this.opts.send(IPC.tileExit, tileId, payload);
      if (this.sessions.get(tileId) === entry) this.sessions.delete(tileId);
      for (const resolve of entry.exitWaiters.splice(0)) resolve();
    });
    this.sessions.set(tileId, entry);
    return { pid: term.pid, cwd: opts.cwd };
  }

  write(tileId: string, data: string): void {
    const session = this.sessions.get(tileId);
    if (!session) return;
    try {
      session.pty.write(data);
    } catch {
      // the pty exited between our lookup and the write — nothing to do
    }
  }

  cwdOf(tileId: string): string | null {
    return this.sessions.get(tileId)?.cwd ?? null;
  }

  resize(tileId: string, cols: number, rows: number): void {
    const session = this.sessions.get(tileId);
    if (!session) return;
    try {
      session.pty.resize(Math.max(cols, 2), Math.max(rows, 2));
    } catch {
      // the pty exited between our lookup and the resize — nothing to do
    }
  }

  /** Whether a live pty is registered for the tile (kill() is a no-op otherwise). */
  has(tileId: string): boolean {
    return this.sessions.has(tileId);
  }

  /** Number of live PTYs (per-session spawn cap). */
  count(): number {
    return this.sessions.size;
  }

  /** Synchronous best-effort kill of an entry (spawn-overwrite path). */
  private hardKill(entry: PtySessionEntry): void {
    if (entry.killTimer !== null) {
      clearTimeout(entry.killTimer);
      entry.killTimer = null;
    }
    try {
      process.kill(-entry.pty.pid, 'SIGKILL');
    } catch {
      try {
        entry.pty.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }

  /** SIGTERM the process group, escalate to SIGKILL after the grace period,
   *  and resolve once the pty has actually exited (bounded by the escalation
   *  itself). Never returns before the kill has been delivered — app quit
   *  awaits this so children cannot orphan (audit PTY-02). */
  kill(tileId: string): Promise<void> {
    const session = this.sessions.get(tileId);
    if (!session) return Promise.resolve();
    const { pty: term } = session;
    const exited = new Promise<void>((resolve) => session.exitWaiters.push(resolve));
    try {
      process.kill(-term.pid, 'SIGTERM');
    } catch {
      try {
        term.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
    session.killTimer = setTimeout(() => {
      session.killTimer = null;
      // only escalate while this exact session still owns the tileId
      if (this.sessions.get(tileId) === session) {
        try {
          process.kill(-term.pid, 'SIGKILL');
        } catch {
          try {
            term.kill('SIGKILL');
          } catch {
            // already gone
          }
        }
      }
    }, 2_000);
    // the timer stays referenced until the pty exits: an unref'd escalation
    // can be skipped when the event loop drains during quit
    return Promise.race([
      exited,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 3_000);
        t.unref();
      }),
    ]).then(() => {
      if (session.killTimer !== null) {
        clearTimeout(session.killTimer);
        session.killTimer = null;
      }
    });
  }

  killAll(): void {
    for (const tileId of [...this.sessions.keys()]) void this.kill(tileId);
  }

  /** Quit path: every group is SIGKILLed and awaited under one deadline. */
  async killAllAndWait(timeoutMs = 3_000): Promise<void> {
    const all = [...this.sessions.keys()].map((tileId) => this.kill(tileId));
    await Promise.race([
      Promise.all(all),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        t.unref();
      }),
    ]);
    // anything still alive after the deadline gets an immediate SIGKILL
    for (const tileId of [...this.sessions.keys()]) {
      const entry = this.sessions.get(tileId);
      if (entry) this.hardKill(entry);
    }
  }
}
