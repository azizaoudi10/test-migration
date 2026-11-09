import { existsSync, watch, type FSWatcher } from 'node:fs';

const DEBOUNCE_MS = 300;
/** Cap for inotify handles a renderer can pin (audit PTY-25). */
const MAX_WATCHERS = 512;
/** How long an app-caused write is ignored (atomic save suppression). */
const SELF_WRITE_MS = 800;

/** Watches open editor files for out-of-app changes (an agent editing the
 *  file on disk while the editor holds it). One fs.watch handle per path;
 *  change events are debounced per path so a burst of writes yields one
 *  notification. Watchers are non-persistent: they never keep the process
 *  alive.
 *
 *  rename handling: the app's own atomic saves (tmp+rename) and agent edits
 *  both fire 'rename', which kills the inode binding. The watch is re-armed
 *  shortly after (the file exists again by then) so detection never dies —
 *  and app-caused writes are suppressed so the user's own Ctrl+S cannot
 *  flash a stale banner (audit PTY-06). */
export class FileWatchRegistry {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Set<string>();
  private readonly suppressed = new Map<string, number>();

  constructor(private readonly onChange: (path: string) => void) {}

  /** Ignore change events for `path` for a short window (called by the
   *  app's own write/rename handlers). */
  suppress(path: string, ms: number = SELF_WRITE_MS): void {
    this.suppressed.set(path, Date.now() + ms);
  }

  private isSuppressed(path: string): boolean {
    const until = this.suppressed.get(path);
    if (until === undefined) return false;
    if (Date.now() > until) {
      this.suppressed.delete(path);
      return false;
    }
    return true;
  }

  watch(path: string): void {
    if (this.watchers.has(path)) return;
    // LRU: Map iteration is insertion order — drop the oldest handle first
    if (this.watchers.size >= MAX_WATCHERS) {
      const oldest = this.watchers.keys().next().value;
      if (oldest !== undefined) this.unwatch(oldest);
    }
    try {
      const watcher = watch(path, { persistent: false }, (event) => {
        if (this.isSuppressed(path)) return;
        // 'rename' covers atomic write-temp+rename (this app's own
        // writeAtomic, vim, most agents) — treating it as a change keeps the
        // stale banner honest; the inode binding is dead after a rename, so
        // re-arm the watch once the replacement file exists
        if (event === 'rename') {
          this.unwatch(path);
          this.onChange(path);
          const rearm = setTimeout(() => {
            if (existsSync(path)) this.watch(path);
          }, 60);
          rearm.unref?.();
          return;
        }
        if (event !== 'change') return;
        this.pending.add(path);
        if (this.timers.has(path)) return;
        const timer = setTimeout(() => {
          this.timers.delete(path);
          if (this.pending.has(path)) {
            this.pending.delete(path);
            if (!this.isSuppressed(path)) this.onChange(path);
          }
        }, DEBOUNCE_MS);
        this.timers.set(path, timer);
      });
      watcher.on('error', () => this.unwatch(path));
      this.watchers.set(path, watcher);
    } catch {
      // the file may already be gone — nothing to watch
    }
  }

  unwatch(path: string): void {
    const timer = this.timers.get(path);
    if (timer) clearTimeout(timer);
    this.timers.delete(path);
    this.pending.delete(path);
    const watcher = this.watchers.get(path);
    if (watcher) {
      watcher.close();
      this.watchers.delete(path);
    }
  }
}
