import { join } from 'node:path';
import type { FraktoleMessage, ReviewerEntry, SessionFile, SessionState } from '../src/shared/ipc.js';
import type { LoopCadence } from '../src/shared/loop-cadence.js';
import type { AutonomyVariant } from '../src/shared/autonomy.js';
import type { ReviewerStatus } from './reviewer.js';

/** Minimal shapes the runtime depends on, so tests can inject fakes. */
export interface RuntimeHost {
  spawn(tileId: string, opts: { cwd: string; cols: number; rows: number; command?: string; args?: string[]; envExt?: Record<string, string> }): { pid: number; cwd: string };
  kill(tileId: string): void;
  killAll(): void;
  /** Awaitable variant used at quit: SIGKILL escalation + bounded wait. */
  killAllAndWait?(timeoutMs?: number): Promise<void>;
  /** Liveness / population queries (spawn cap, dead-agent checks). */
  has?(tileId: string): boolean;
  count?(): number;
  write(tileId: string, data: string): void;
  resize(tileId: string, cols: number, rows: number): void;
  cwdOf(tileId: string): string | null;
}

/** The harness reviewer: our own model loop (no PTY, no CLI). Spawned lazily
 *  when its tab is visited; idles out when backgrounded. */
export interface RuntimeReviewer {
  status: ReviewerStatus;
  start(sessionId: string, sessionDir: string, cwd: string): Promise<boolean>;
  stop(): void;
  idleOut(): void;
  restart(): Promise<boolean>;
  compact(): void;
  /** Accepts the prompt (reviving the harness if it was down); false when
   *  explicitly stopped or unconfigured. */
  prompt(text: string): Promise<boolean>;
  cancel(): void;
  setGoal(text: string | null): Promise<boolean>;
  /** The reviewer's live working directory (fork while autonomy armed). */
  activeCwd?(): string;
  /** Swap the autonomous-mode variant (null clears it) + rebuild the prompt. */
  setVariant(variant: AutonomyVariant | null): Promise<void>;
  /** Start an autonomous run: fork, arm the mission goal, kick off. mode
   *  'auto' resumes a prior run in place when one exists; 'fresh' re-forks. */
  startAutonomy(variant: AutonomyVariant, mode?: 'auto' | 'fresh'): Promise<{ ok: boolean; error?: string }>;
  /** True when re-entering `variant` can resume a prior run (active goal +
   *  existing non-empty fork); the UI offers a dialog on this. */
  resumableRun(variant: AutonomyVariant): Promise<{ resumable: boolean; goalText: string | null }>;
  /** Ask the model for a session recap, persist it, and compact context. */
  summarizeSession(): { ok: boolean; error?: string };
  /** Live "loops hunger" update: swap the poll cadence (interval)
   *  without a reviewer restart. */
  setCadence(cadence: LoopCadence): void;
  /** True when an autonomous run is live (variant set + goal active).
   *  While true, backgrounding the session never idles the reviewer out. */
  isAutonomyActive(): boolean;
  answerQuestion(askId: string, answer: string): void;
  killAgentNow(agentId: string): Promise<string>;
  /** Live transcript entries, for the Reviewer tab on mount. */
  conversation: ReviewerEntry[];
}

export interface RuntimeRouter {
  start(sessionId: string): void;
  stop(): void;
  sendFromOrchestrator(msg: {
    id: string;
    from: string;
    to: string;
    kind: 'task' | 'result' | 'note';
    body: string;
    ref?: string;
    at: number;
  }): Promise<boolean>;
  listMessages(sessionId: string): Promise<FraktoleMessage[]>;
}

export interface SessionRuntimeOpts {
  session: SessionFile;
  sessionRoot: string; // userData/sessions
  host: RuntimeHost;
  reviewer: RuntimeReviewer;
  router: RuntimeRouter;
  judgeCwd: () => string;
  idleTimeoutMs?: number;
  logger?: (line: string) => void;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

/**
 * One live session: its PTY host, reviewer harness and mailbox router, plus
 * the lifecycle state machine.
 *
 *   running  — everything alive (may be backgrounded)
 *   idle     — backgrounded long enough that the reviewer shut down (tiles stay)
 *   stopped  — user switched it off: all PTYs and the reviewer are dead
 *
 * Keep-alive: a backgrounded session keeps its tiles running; only the
 * reviewer idles out. Explicit stop tears the whole runtime down; start
 * revives it (the renderer re-spawns tiles from the persisted arrangement).
 */
export class SessionRuntime {
  state: SessionState = 'running';
  agentToTile = new Map<string, string>();
  lastActiveAt = Date.now();

  private sessionRef: SessionFile;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly idleTimeoutMs: number;
  /** Re-checks a backgrounded autonomy-exempt session so the idle timer is
   *  re-armed when the run ends instead of never firing (audit PTY-30). */
  private autonomyWatch: NodeJS.Timeout | null = null;

  constructor(private readonly opts: SessionRuntimeOpts) {
    this.sessionRef = opts.session;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  get id(): string {
    return this.sessionRef.id;
  }

  get session(): SessionFile {
    return this.sessionRef;
  }

  get host(): RuntimeHost {
    return this.opts.host;
  }

  get reviewer(): RuntimeReviewer {
    return this.opts.reviewer;
  }

  get router(): RuntimeRouter {
    return this.opts.router;
  }

  /** Keep the runtime's view of the session file in sync after saves. */
  updateSession(session: SessionFile): void {
    this.sessionRef = session;
  }

  sessionDir(): string {
    return join(this.opts.sessionRoot, this.sessionRef.id);
  }

  /** Called when this session becomes the active one. */
  activate(): void {
    this.lastActiveAt = Date.now();
    this.clearIdleTimer();
    this.clearAutonomyWatch();
    if (this.state === 'stopped') {
      this.state = 'running';
    }
    this.opts.router.start(this.sessionRef.id);
  }

  /** Called when another session becomes active. An active auto-compose
   *  run is exempt: backgrounding never idles it out, so the loop carrier
   *  keeps polling until the goal is met, cleared, or explicitly stopped.
   *  The exemption is re-checked periodically: once the run ends, the idle
   *  timer arms again (audit PTY-30). */
  deactivate(): void {
    this.lastActiveAt = Date.now();
    if (this.opts.reviewer.isAutonomyActive()) {
      this.opts.logger?.(`session ${this.id}: idle-kill skipped (auto-compose run active)`);
      if (this.autonomyWatch === null) {
        this.autonomyWatch = setInterval(() => {
          if (!this.opts.reviewer.isAutonomyActive()) {
            this.clearAutonomyWatch();
            this.startIdleTimer();
          }
        }, 30_000);
        this.autonomyWatch.unref();
      }
      return;
    }
    this.startIdleTimer();
  }

  /** The reviewer starts only when its tab is actually visited. Revives a
   *  stopped session first. */
  ensureReviewer(): Promise<boolean> {
    if (this.state === 'stopped') this.start();
    if (this.opts.reviewer.status === 'running') {
      return Promise.resolve(true);
    }
    return this.opts.reviewer.start(this.sessionRef.id, this.sessionDir(), this.opts.judgeCwd());
  }

  /** Explicit off switch: kills every PTY and the reviewer. */
  stop(): void {
    this.clearIdleTimer();
    this.clearAutonomyWatch();
    this.opts.host.killAll();
    this.opts.reviewer.stop();
    this.opts.router.stop();
    this.state = 'stopped';
  }

  /** Revives a stopped session; the renderer re-spawns the tiles and the
   *  reviewer comes back on the next reviewer visit. */
  start(): void {
    if (this.state !== 'stopped') return;
    this.state = 'running';
    this.opts.router.start(this.sessionRef.id);
  }

  /** Full teardown (session deleted). */
  teardown(): void {
    this.clearIdleTimer();
    this.clearAutonomyWatch();
    this.opts.host.killAll();
    this.opts.reviewer.stop();
    this.opts.router.stop();
    this.state = 'stopped';
  }

  killAll(): void {
    this.opts.host.killAll();
  }

  async killAllAndWait(timeoutMs = 3_000): Promise<void> {
    await this.opts.host.killAllAndWait?.(timeoutMs);
  }

  private startIdleTimer(): void {
    if (this.idleTimer !== null || this.state === 'stopped') return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // still backgrounded: shut the reviewer down, keep the tiles alive
      if (this.state !== 'stopped') {
        this.opts.reviewer.idleOut();
        this.state = 'idle';
        this.opts.logger?.(`session ${this.id}: reviewer idle-shutdown`);
      }
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearAutonomyWatch(): void {
    if (this.autonomyWatch !== null) {
      clearInterval(this.autonomyWatch);
      this.autonomyWatch = null;
    }
  }
}

export interface SessionRegistryOpts {
  sessionRoot: string;
  makeRuntime: (session: SessionFile) => SessionRuntime;
  logger?: (line: string) => void;
}

/**
 * All live sessions. Runtimes are created lazily on first open and stay
 * until the session is deleted or the app quits.
 */
export class SessionRegistry {
  private readonly runtimes = new Map<string, SessionRuntime>();
  private activeId: string | null = null;

  constructor(private readonly opts: SessionRegistryOpts) {}

  get active(): string | null {
    return this.activeId;
  }

  get(id: string): SessionRuntime | null {
    return this.runtimes.get(id) ?? null;
  }

  all(): SessionRuntime[] {
    return [...this.runtimes.values()];
  }

  /** Activates a session, creating its runtime on first visit. */
  open(id: string, session: SessionFile): SessionRuntime {
    if (this.activeId !== null && this.activeId !== id) {
      this.runtimes.get(this.activeId)?.deactivate();
    }
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = this.opts.makeRuntime(session);
      this.runtimes.set(id, rt);
    }
    rt.updateSession(session);
    rt.activate();
    this.activeId = id;
    return rt;
  }

  stop(id: string): void {
    this.runtimes.get(id)?.stop();
  }

  start(id: string): void {
    this.runtimes.get(id)?.start();
  }

  /** Deletes the runtime (and kills everything in it). */
  teardown(id: string): void {
    this.runtimes.get(id)?.teardown();
    this.runtimes.delete(id);
    if (this.activeId === id) this.activeId = null;
  }

  /** App quit: everything dies. */
  killAll(): void {
    for (const rt of this.runtimes.values()) rt.killAll();
  }

  /** App quit with a bounded await so SIGKILL escalation actually lands and
   *  children cannot orphan (audit PTY-02). */
  async killAllAndWait(timeoutMs = 3_000): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((rt) => rt.killAllAndWait(timeoutMs)));
  }
}

