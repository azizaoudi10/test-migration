import { Notification, type BrowserWindow } from 'electron';
import { IPC } from '../src/shared/ipc.js';

/** Native desktop notifications for reviewer events. Skips silently when
 *  notifications are disabled, when the window exists and is focused (the
 *  user is already looking at the app), or when the same (session, kind) was
 *  notified within the last 30s — a goal-met must never swallow a following
 *  needs-input. Never throws. */
export interface NotifyDeps {
  getWindow: () => BrowserWindow | null;
  isEnabled: () => Promise<boolean>;
  /** In-app fallback when the OS notification cannot be shown. */
  onUnsupported?: (title: string, body: string) => void;
}

const DEDUPE_MS = 30_000;
const DEDUPE_MAX = 64;

let deps: NotifyDeps | null = null;
const lastShownAt = new Map<string, number>();

/** Wires the module to the app: the window getter and the settings check. */
export function initNotify(d: NotifyDeps): void {
  deps = d;
}

export async function notifyReviewer(opts: { sessionId: string; title: string; body: string; kind?: string }): Promise<void> {
  try {
    const d = deps;
    if (!d || !(await d.isEnabled())) return;
    const win = d.getWindow();
    if (win && win.isFocused()) return;
    const now = Date.now();
    const key = `${opts.sessionId}:${opts.kind ?? opts.title}`;
    const prev = lastShownAt.get(key);
    if (prev !== undefined && now - prev < DEDUPE_MS) return;
    // prune unconditionally so the map can never grow past the cap
    for (const [id, at] of [...lastShownAt]) {
      if (now - at >= DEDUPE_MS) lastShownAt.delete(id);
    }
    while (lastShownAt.size >= DEDUPE_MAX) {
      const oldest = lastShownAt.keys().next().value;
      if (oldest === undefined) break;
      lastShownAt.delete(oldest);
    }
    lastShownAt.set(key, now);
    if (!Notification.isSupported()) {
      d.onUnsupported?.(opts.title, opts.body);
      return;
    }
    const note = new Notification({ title: opts.title, body: opts.body });
    note.on('click', () => {
      try {
        const w = d.getWindow();
        if (w) {
          if (w.isMinimized()) w.restore();
          w.show();
          w.focus();
        }
        w?.webContents.send(IPC.menuSession, { action: 'open', id: opts.sessionId });
      } catch {
        // click handling must never surface either
      }
    });
    note.show();
  } catch {
    // a notification failure must be invisible
  }
}
