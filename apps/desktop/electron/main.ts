import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import { copyFile, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildAgentEnv } from './agent-env.js';
import { MailboxRouter, ORCHESTRATOR_ID, messageId } from './mailbox.js';
import { readMessagesJsonl } from './messages-log.js';
import { listProjectFiles, invalidateProjectFiles } from './project-files.js';
import { listModels } from './model-list.js';
import { loadPty } from './preflight.js';
import { PtyHost } from './pty-host.js';
import { ProjectsStore } from './projects.js';
import { PromptStore } from './prompt-store.js';
import { RemoteBridge, lanIps } from './remote/bridge.js';
import type { RemoteBackend, SessionRow, TileRow, MessageRow } from './remote/backend.js';
import { RemoteStore } from './remote/store.js';
import { ReviewerHost, type ReviewerToolCallEvent } from './reviewer.js';
import { AUTONOMY_VARIANTS, type AutonomyVariant } from './reviewer-plugins.js';
import { forkProject } from './fork.js';
import { ReviewerTools, validateLauncherKind } from './reviewer-tools.js';
import { commandIsPlainLaunch, effectiveAllowlist, launcherFirstToken, sanitizeHarnessSlots } from '../src/shared/launchers.js';
import { exportSessionBundle, importSessionBundle, type BundleResult } from './session-bundle.js';
import { createFileForUser, mkdirForUser, renameForUser, trashForUser, writeAtomic } from './fs-ops.js';
import { confineNoSymlinks, confinePath, confineOrThrow } from './fs-scope.js';
import { sanitizeSerNode, serNodeAgentIds } from '../src/session-tree.js';
import { FileWatchRegistry } from './fs-watch.js';
import { collectGitStatus } from './git-status.js';
import { searchProject } from './project-search.js';
import { UsageLog } from './usage-log.js';
import { initNotify, notifyReviewer } from './notify.js';
import { SessionRegistry, SessionRuntime } from './session-runtime.js';
import { deriveLoopCadence } from '../src/shared/loop-cadence.js';
import { SessionStore } from './sessions.js';
import { SettingsStore } from './settings.js';
import { ScrollbackPersist } from './scrollback-persist.js';
import { TileRecorder } from './tile-recorder.js';
import {
  IPC,
  type AppInfo,
  type FsEntry,
  type FsStat,
  type OpenedSession,
  type Project,
  type PromptDraft,
  type PtySpawnArgs,
  type PtySpawnResult,
  type RemoteStatus,
  type SessionFile,
  type SessionSavePayload,
  type Settings,
  type ReviewerEntry,
  type ReviewerProbeArgs,
  type ReviewerProbeResult,
  type ReviewerSpawnRequest,
  type TestPageState,
} from '../src/shared/ipc.js';
import { probeLocalServer } from './reviewer/local-probe.js';
import { THEME_IDS, type ThemeId } from '../src/themes.js';

// Consistent identity across dev, local install and packaged builds: WM_CLASS,
// window association and the userData directory all key off the app name.
app.setName('Fraktole');

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5173';

async function waitForDevServer(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // each attempt gets its own deadline so a stalled connection can never
    // hang the boot sequence past the overall timeout
    const controller = new AbortController();
    const attemptTimer = setTimeout(() => controller.abort(), 1_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.ok) return;
    } catch {
      // server not up yet — keep polling
    } finally {
      clearTimeout(attemptTimer);
    }
    if (Date.now() > deadline) throw new Error(`dev server unreachable at ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

let mainWindow: BrowserWindow | null = null;
let currentTheme: ThemeId = 'midnight';
let registry: SessionRegistry | null = null;
/** In-flight reviewer spawns awaiting the renderer's tile mount. */
const pendingSpawns = new Map<string, { sessionId: string; agentId: string; resolve(out: string): void }>();
/**
 * Settles the pending spawn for an agent with a final verdict. Called from
 * the ptySpawn outcome (success or failure) — never from the mount ack,
 * which only proves the renderer mounted a tile, not that the PTY lives.
 * Identity is (sessionId, agentId): agent ids are per-session sequences, so
 * matching on agentId alone would settle the wrong session's spawn.
 */
function settlePendingSpawn(sessionId: string, agentId: string | undefined, out: string): void {
  if (typeof agentId !== 'string') return;
  for (const [requestId, pending] of pendingSpawns) {
    if (pending.sessionId === sessionId && pending.agentId === agentId) {
      pendingSpawns.delete(requestId);
      pending.resolve(out);
      return;
    }
  }
}
/** In-flight test-page reads/screenshots awaiting the renderer. */
const pendingTestReads = new Map<string, { resolve(out: string): void; timer: NodeJS.Timeout }>();
const pendingTestShots = new Map<string, { resolve(out: string): void; timer: NodeJS.Timeout }>();
/** Per-session background-job registries (stopped with the session). */
let testSeq = 0;

/** Per-session live infra the remote bridge reads: the PTY recorder and the
 *  set of live tile ids (fed by the ptyData/tileExit send hook). */
const sessionInfra = new Map<string, { recorder: TileRecorder; alive: Set<string>; persist: ScrollbackPersist; host?: PtyHost }>();
/** Durable agentId → tile kind ('agent' launcher vs plain 'shell'). */
const agentKinds = new Map<string, 'agent' | 'shell' | 'reviewer'>();

function testRoundTrip(
  map: Map<string, { resolve(out: string): void; timer: NodeJS.Timeout }>,
  channel: string,
  sessionId: string,
): Promise<string> {
  return new Promise<string>((resolve) => {
    const requestId = `test-${Date.now()}-${++testSeq}`;
    const timer = setTimeout(() => {
      map.delete(requestId);
      resolve('error: the Test tab did not respond');
    }, 8_000);
    map.set(requestId, { resolve, timer });
    mainWindow?.webContents.send(channel, sessionId, { requestId });
  });
}

/** Guest-browser policy: window.open / target=_blank from a tested page
 *  navigates in-tab (the user chose all-in-tab behavior); guests never get
 *  the shell's preload or bridge. */
function wireGuestPolicy(): void {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url }) => {
      void contents.loadURL(url).catch(() => undefined);
      return { action: 'deny' };
    });
    // harden every dynamically attached guest: no preload, no node, sandbox
    // stays on regardless of the embedder's webpreferences (audit SEC-7)
    contents.on('will-attach-webview', (_e, webPreferences) => {
      delete (webPreferences as { preload?: string }).preload;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
    });
  });
}

/** Packaged-only CSP: the renderer is local content and must not load
 *  remote scripts or connect anywhere (dev keeps HMR websockets). */
function wireContentSecurity(): void {
  if (!app.isPackaged) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'",
        ],
      },
    });
  });
}

/** Custom application menu: File → New Tile/Quit, Session actions, and the


/**
 * Older builds stored data under the package-name userData dir
 * (~/.config/@fraktole/desktop). Migrate the project list once.
 */
function migrateUserData(): void {
  const current = app.getPath('userData');
  const legacy = join(app.getPath('appData'), '@fraktole', 'desktop');
  if (legacy === current) return;
  if (existsSync(join(current, 'projects.json'))) return;
  const legacyProjects = join(legacy, 'projects.json');
  if (existsSync(legacyProjects)) {
    try {
      copyFile(legacyProjects, join(current, 'projects.json'), (err) => {
        if (err) console.error('migrate projects.json failed:', err);
      });
    } catch {
      // migration is best-effort
    }
  }
}

/** Optional CLI tools the app shells out to (git for projects/fork/status,
 *  tar for session bundles). rg degrades to a JS walk. Missing tools are
 *  surfaced once, non-blocking, instead of failing with raw errors later. */
function warnMissingOptionalTools(win: BrowserWindow): void {
  const missing: string[] = [];
  for (const tool of ['git', 'tar']) {
    try {
      execFileSync(tool, ['--version'], { stdio: 'ignore' });
    } catch {
      missing.push(tool);
    }
  }
  if (missing.length === 0) return;
  void dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Optional tools missing',
    message: `${missing.join(' and ')} not found on PATH`,
    detail:
      'Project detection, git status, auto-compose forks and session bundles need these tools. ' +
      'Install them (e.g. apt install git tar) and restart Fraktole.',
    buttons: ['OK'],
  });
}

/** Per-tile PTY output high-water mark before the coalescing flush: 1 MiB
 *  bounds main-process memory under a flooding producer (audit PTY-11). */
const MAX_PENDING_PTY_BYTES = 1_048_576;
/** Hard per-session PTY cap (renderer bug/compromise cannot exhaust PIDs). */
const MAX_PTY_PER_SESSION = 24;

function createWindow(): void {
  // a recreated window (macOS activate after close) rebuilds its tiles with
  // fresh ids: orphan the old PTYs first so they cannot keep running
  // untracked alongside their replacements (audit PTY-33)
  if (registry) void registry.killAllAndWait(1_500);
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#171a20',
    show: false,
    title: 'Fraktole',
    icon: join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // the Test tab embeds a sandboxed guest browser
      webviewTag: true,
    },
  });
  win.setMenuBarVisibility(false);
  Menu.setApplicationMenu(null);
  mainWindow = win;

  win.once('ready-to-show', () => {
    win.show();
    warnMissingOptionalTools(win);
  });
  // a closed window must never keep being the send target: webContents.send
  // on a destroyed window throws (macOS keeps the app alive without a window)
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // a main-frame navigation (e.g. reload) would orphan every running PTY:
  // the renderer would reset to zero tiles while the runtimes keep sessions.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('render-process-gone', () => {
    registry?.killAll();
    app.quit();
  });

  void (async () => {
    if (!app.isPackaged) {
      await waitForDevServer(DEV_SERVER_URL);
      await win.loadURL(DEV_SERVER_URL);
    } else {
      await win.loadFile(join(__dirname, '..', 'dist-renderer', 'index.html'));
    }
  })();
}

if (!app.requestSingleInstanceLock()) {
  // a second launch (app menu, desktop entry, repeated command) while an
  // instance is already running: quit silently — the first instance is
  // told to come forward by the second-instance event below
  app.quit();
} else {
  // bring the existing window forward (shared by the second-instance event
  // and the launcher's SIGUSR2 when it detects a running instance)
  const focusApp = (): void => {
    if (!mainWindow) return;
    if (mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };
  app.on('second-instance', focusApp);
  // the launcher sends this instead of spawning a doomed second Electron
  // (whose zygotes would leak as orphans); some args-bearing launches still
  // fall through to the second-instance event above
  process.on('SIGUSR2', focusApp);

  app.whenReady().then(async () => {
    // native addon preflight: on an old glibc this shows an actionable dialog
    // instead of crashing at the first PTY spawn
    if (!loadPty()) return;
    wireGuestPolicy();
    wireContentSecurity();
    migrateUserData();
    const projects = new ProjectsStore(join(app.getPath('userData'), 'projects.json'));
    const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'));
    // harness slots feed ReviewerTools construction inside the SYNC
    // makeRuntime — cache them here (primed once, refreshed on save); slot
    // edits apply on reviewer restart, like the toolsFloorTokens they feed
    let cachedHarnesses: string[] | undefined;
    const refreshHarnessesCache = async (): Promise<void> => {
      cachedHarnesses = sanitizeHarnessSlots((await settings.get()).reviewer.harnesses);
    };
    void refreshHarnessesCache();
    const sessions = new SessionStore(join(app.getPath('userData'), 'sessions'));
    const sessionsRoot = join(app.getPath('userData'), 'sessions');
    const promptStore = new PromptStore(join(app.getPath('userData'), 'prompts.json'));
    // sweep crash-left import/tmp litter so startup always begins clean
    // (audit PTY-35)
    try {
      for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
        if (entry.name.startsWith('.import-') || entry.name.endsWith('.tmp')) {
          await rm(join(sessionsRoot, entry.name), { recursive: true, force: true }).catch(() => undefined);
        }
      }
    } catch {
      // no sessions root yet — nothing to sweep
    }
    const home = app.getPath('home');

    const judgeCwdFor = (session: SessionFile): string =>
      session.projectPath ?? session.judge?.cwd ?? home;

    /** Registered project roots — the only filesystem scope the app's own UI
     *  ever uses. Every renderer-supplied path must confine to one of these
     *  (fs-scope.ts); the renderer runs web content and is not trusted. */
    const projectRoots = async (): Promise<string[]> => {
      try {
        return (await projects.list()).map((p) => p.path);
      } catch {
        return [];
      }
    };

    /** Sessions deleted this run: a late write/spawn for one of these must
     *  never resurrect the directory on disk (audit PTY-04). */
    const deletedSessions = new Set<string>();

    // one live runtime per session; created lazily on first visit
    registry = new SessionRegistry({
      sessionRoot: sessionsRoot,
      logger: (line) => console.log(line),
      makeRuntime: (session: SessionFile): SessionRuntime => {
        let rt: SessionRuntime | null = null;
        const recorder = new TileRecorder({ logger: (line) => console.log(line) });
        const alive = new Set<string>();
        const tileOfAgent = (agentId: string): string | null =>
          agentId === ORCHESTRATOR_ID ? null : (rt?.agentToTile.get(agentId) ?? null);
        const agentOfTile = (tileId: string): string | null => {
          for (const [agentId, tid] of rt?.agentToTile ?? []) {
            if (tid === tileId) return agentId;
          }
          return null;
        };
        // durable scrollback writer: keeps each agent's scrollback file fresh
        // on the hot path so read_scrollback's disk fallback and remote/restore
        // views are never more than ~1s stale (vs up to 30s at save time)
        const persist = new ScrollbackPersist({
          sessionDir: join(sessionsRoot, session.id),
          agentOfTile,
          linesOf: (tileId) => recorder.full(tileId),
        });
        const infraEntry: { recorder: TileRecorder; alive: Set<string>; persist: ScrollbackPersist; host?: PtyHost } = { recorder, alive, persist };
        sessionInfra.set(session.id, infraEntry);
        // ptyData chunks are coalesced per tile per tick: one IPC send and
        // one remote publish per tick instead of per chunk
        const pendingChunks = new Map<string, { sessionId: string; tileId: string; chunks: string[]; bytes: number }>();
        const exitedTiles = new Map<string, string>();
        let flushScheduled = false;
        const flushTile = (key: string): void => {
          const entry = pendingChunks.get(key);
          if (!entry || entry.chunks.length === 0) return;
          pendingChunks.delete(key);
          const data = entry.chunks.join('');
          entry.chunks.length = 0;
          entry.bytes = 0;
          // node-pty does not strictly order final output before exit: a
          // chunk that arrives after tileExit must not resurrect recorder,
          // persist or alive state for a dead tile
          if (!alive.has(entry.tileId) && exitedTiles.get(entry.tileId) === entry.sessionId) {
            return;
          }
          recorder.record(entry.tileId, data);
          persist.note(entry.tileId);
          alive.add(entry.tileId);
          remote?.publish({
            type: 'tile.output',
            sessionId: entry.sessionId,
            tileId: entry.tileId,
            data,
            ts: Date.now(),
          });
          mainWindow?.webContents.send(IPC.ptyData, entry.sessionId, entry.tileId, data);
        };
        const flushChunks = (): void => {
          flushScheduled = false;
          for (const key of [...pendingChunks.keys()]) flushTile(key);
        };
        const enqueueChunk = (sessionId: string, tileId: string, data: string): void => {
          const key = `${sessionId}\u0000${tileId}`;
          const entry = pendingChunks.get(key) ?? { sessionId, tileId, chunks: [], bytes: 0 };
          // high-water mark: a flooding producer (yes, cat of a huge file)
          // must not grow main memory without bound between ticks — keep the
          // newest bytes and record what was dropped (audit PTY-11)
          if (data.length > MAX_PENDING_PTY_BYTES) {
            const marker = '\r\n[fraktole: output burst truncated]\r\n';
            const kept = data.slice(data.length - MAX_PENDING_PTY_BYTES / 2);
            entry.chunks.push(`${marker}${kept}`);
            entry.bytes += marker.length + kept.length;
          } else {
            entry.chunks.push(data);
            entry.bytes += data.length;
          }
          if (entry.bytes > MAX_PENDING_PTY_BYTES) {
            let dropped = 0;
            while (entry.bytes > MAX_PENDING_PTY_BYTES && entry.chunks.length > 1) {
              const first = entry.chunks.shift()!;
              entry.bytes -= first.length;
              dropped += first.length;
            }
            if (dropped > 0) entry.chunks.unshift(`[fraktole: ${dropped} bytes of output dropped]\r\n`);
          }
          pendingChunks.set(key, entry);
          if (!flushScheduled) {
            flushScheduled = true;
            setImmediate(flushChunks);
          }
        };
        const host = new PtyHost({
          send: (channel, tileId, payload) => {
            if (channel === IPC.ptyData) {
              // the recording: every agent PTY chunk is teed into the
              // in-memory ring before being forwarded to the renderer
              enqueueChunk(session.id, tileId, payload as string);
            } else if (channel === IPC.tileExit) {
              // order matters: pending output must reach the renderer before
              // the exit event that closes the tile
              flushTile(`${session.id}\u0000${tileId}`);
              alive.delete(tileId);
              exitedTiles.set(tileId, session.id);
              // persist the final lines before the recorder drops them — the
              // exit flush must capture everything, even if the debounce had
              // not fired yet
              void persist.flushTile(tileId, recorder.full(tileId));
              const lines = recorder.summary(tileId).lines;
              recorder.drop(tileId);
              for (const [agentId, tid] of [...(rt?.agentToTile ?? [])]) {
                if (tid === tileId) rt?.agentToTile.delete(agentId);
              }
              remote?.publish({
                type: 'tile.state',
                sessionId: session.id,
                tileId,
                alive: false,
                lines,
              });
            }
            // keep-alive: every live session streams its events, tagged with
            // its sessionId; the renderer filters per mounted SessionView
            if (channel === IPC.tileExit) {
              mainWindow?.webContents.send(channel, session.id, tileId, payload);
            }
          },
        });
        infraEntry.host = host;
        const cwdOfAgent = (agentId: string): string | null =>
          rt?.session.tiles.find((t) => t.agentId === agentId)?.cwd ?? null;
        const router = new MailboxRouter({
          root: sessionsRoot,
          currentSession: () => rt?.session ?? session,
          tileOfAgent,
          isTileLive: (tileId) => host.has(tileId),
          write: (tileId, text) => host.write(tileId, text),
          emit: (msg) => {
            remote?.publish({
              type: 'message.new',
              sessionId: session.id,
              msg: { kind: msg.kind, from: msg.from, to: msg.to, body: msg.body, ts: msg.at },
            });
          },
        });
        const tools = new ReviewerTools(cachedHarnesses);
        const reviewer = new ReviewerHost({
          getConfig: () => settings.get().then((s) => s.reviewer),
          sessionId: session.id,
          sessionDir: join(sessionsRoot, session.id),
          cwd: judgeCwdFor(session),
          forksRoot: join(app.getPath('userData'), 'forks'),
          forkProject: (variant, keepExisting) => {
            if (!rt) return Promise.resolve({ ok: false as const, error: 'no runtime for session' });
            const src = judgeCwdFor(rt.session);
            // forks live OUTSIDE the source repo: no .fraktole-auto pollution,
            // no git-status noise, no recursive copies inside the project
            // (audit PTY-08)
            return forkProject(src, join(app.getPath('userData'), 'forks', rt.session.id, variant), home, keepExisting);
          },
          recorder,
          toolContext: {
            sessionId: session.id,
            sessionDir: join(sessionsRoot, session.id),
            cwd: judgeCwdFor(session),
            roots: [judgeCwdFor(session)],
            recorder,
            router: {
              sendFromOrchestrator: (msg) => router.sendFromOrchestrator(msg),
            },
            tileOfAgent,
            agentOfTile,
            cwdOfAgent,
            killAgent: async (tileId) => {
              // a no-op kill must not read as success — the model would skip
              // re-dispatching an agent that was never actually running
              if (!host.has(tileId)) return `error: unknown or already-exited tile ${tileId}`;
              host.kill(tileId);
              return `killed ${tileId}`;
            },
            agentCount: () => {
              // only LIVE tiles count against the spawn cap: persisted-but-
              // dead agents must not block new spawns (audit RV-E20)
              let n = 0;
              for (const t of rt?.session.tiles ?? []) {
                const tileId = tileOfAgent(t.agentId);
                if (tileId !== null && host.has(tileId)) n += 1;
              }
              return n;
            },
            spawnAgent: async (kind, cwd, opts) => {
              if (!rt) return 'error: no runtime for session';
              // while autonomy is armed the reviewer works inside its fork;
              // an empty cwd must default there, not to the original repo
              // (audit SEC-RUN-1)
              const fallback = rt.reviewer.activeCwd?.() ?? judgeCwdFor(rt.session);
              const res = await spawnAgentInSession(rt, kind, cwd.length > 0 ? cwd : fallback, opts?.userPicked === true);
              return res.ok ? `spawned agent ${res.agentId}` : res.error;
            },
            openTestPage: async (url) => {
              if (!rt) return 'error: no runtime for session';
              const target = typeof url === 'string' ? url.trim() : '';
              if (target.length === 0) return 'error: url required';
              mainWindow?.webContents.send(IPC.testOpen, rt.session.id, { url: target });
              return `opened ${target} in the Test tab`;
            },
            readTestPage: () => {
              if (!rt) return Promise.resolve('error: no runtime for session');
              return testRoundTrip(pendingTestReads, IPC.testStateRequest, rt.session.id);
            },
            screenshotTestPage: () => {
              if (!rt) return Promise.resolve('error: no runtime for session');
              return testRoundTrip(pendingTestShots, IPC.testScreenshotRequest, rt.session.id);
            },
            reloadTestPage: () => {
              if (!rt) return Promise.resolve('error: no runtime for session');
              mainWindow?.webContents.send(IPC.testReload, rt.session.id);
              return Promise.resolve('reload sent to the Test tab');
            },
            listMessages: () => router.listMessages(session.id),
            writeToAgent: (agentId, command, opts) => {
              if (agentId === ORCHESTRATOR_ID) return Promise.resolve('error: the orchestrator is not an agent tile');
              const tileId = tileOfAgent(agentId);
              if (!tileId) return Promise.resolve(`error: unknown agent ${agentId}`);
              // a persisted-but-dead agent has no PTY: report failure instead
              // of claiming a launch that went nowhere (audit RV-10)
              if (!host.has(tileId)) return Promise.resolve(`error: agent ${agentId} is not running`);
              host.write(tileId, opts?.raw === true ? command : `${command}\n`);
              return Promise.resolve(`launched "${command}" in ${agentId}`);
            },
            // Terminal-input tools may only target a harness tile; a bare shell
            // would execute the input as shell commands.
            isHarnessTile: (tileId) => {
              const agentId = agentOfTile(tileId);
              if (!agentId) return false;
              return rt?.session.tiles.find((t) => t.agentId === agentId)?.kind === 'agent';
            },
            getAllowedLaunchers: async () => (await settings.get()).reviewer.allowedLaunchers ?? [],
            getHarnesses: () => tools.harnesses,
            listAgents: () =>
              (rt?.session.tiles ?? [])
                .filter((t) => {
                  const tileId = tileOfAgent(t.agentId);
                  return tileId !== null && host.has(tileId);
                })
                .map((t) => ({ agentId: t.agentId, cwd: t.cwd })),
          },
          tools,
          emit: {
            status: (status, error, model, variant, detail) => {
              mainWindow?.webContents.send(IPC.reviewerStatus, session.id, { status, error, model, variant, detail });
              if (status === 'error' && error) {
                void notifyReviewer({ sessionId: session.id, title: 'Reviewer error', body: error.slice(0, 160), kind: 'error' });
              }
            },
            stream: (ev) => mainWindow?.webContents.send(IPC.reviewerStream, session.id, ev),
            toolCall: (ev: ReviewerToolCallEvent) =>
              mainWindow?.webContents.send(IPC.reviewerToolCall, session.id, ev),
            message: (entry) => mainWindow?.webContents.send(IPC.reviewerMessage, session.id, entry),
            goal: (ev) => {
              mainWindow?.webContents.send(IPC.reviewerGoal, session.id, ev);
              if (ev.goal?.state === 'met') {
                void notifyReviewer({ sessionId: session.id, title: 'Goal met', body: ev.goal.text.slice(0, 160), kind: 'goal' });
              }
            },
            question: (ev) => {
              mainWindow?.webContents.send(IPC.reviewerQuestion, session.id, ev);
              void notifyReviewer({ sessionId: session.id, title: 'Reviewer needs input', body: ev.question.slice(0, 160), kind: 'question' });
            },
            usage: (ev) => mainWindow?.webContents.send(IPC.reviewerUsage, session.id, ev),
            recap: (recap) => mainWindow?.webContents.send(IPC.reviewerRecap, session.id, recap),
            budget: (info) => mainWindow?.webContents.send(IPC.reviewerBudget, session.id, info),
          },
          logger: (line) => console.log(line),
        });
        const runtime = new SessionRuntime({
          session,
          sessionRoot: sessionsRoot,
          host,
          reviewer,
          router,
          judgeCwd: () => judgeCwdFor(session),
        });
        rt = runtime;
        return runtime;
      },
    });

    const openSession = async (id: string): Promise<OpenedSession> => {
      const session = await sessions.load(id);
      const rt = registry!.open(id, session);
      refreshMenu();
      return { session: rt.session, agents: rt.session.tiles, state: rt.state };
    };

    /** One in-flight project open per resolved project root (git toplevel):
     *  a double-click must not race into two session creations for the same
     *  project, and two paths inside the same repo must dedupe onto one. */
    const pendingProjectOpens = new Map<string, Promise<OpenedSession>>();
    /** Serializes project opens so the resolve-then-check-then-set window
     *  cannot interleave across concurrent opens of the same root. */
    let projectOpenQueue: Promise<unknown> = Promise.resolve();

    /**
     * Spawns a new agent tile in a session's runtime: allocates the durable
     * agentId, persists the tile, and asks the renderer to mount it. Shared
     * by the reviewer harness (spawn_agent tool) and the remote bridge
     * (agent.spawn RPC). Resolves once the renderer reports the tile.
     */
    const spawnAgentInSession = async (
      rt: SessionRuntime,
      kind: string | undefined,
      cwd: string,
      userPicked = false,
      name?: string,
    ): Promise<{ ok: true; agentId: string } | { ok: false; error: string }> => {
      const target = cwd.length > 0 ? cwd : judgeCwdFor(rt.session);
      // the phone's agent.spawn and the reviewer's spawn_agent both land
      // here with a caller-supplied cwd — confine it to registered project
      // roots (+home) exactly like the renderer ptySpawn path (SEC-3/RV-11)
      let confined: string;
      try {
        confined = await confineOrThrow([...(await projectRoots()), home], target);
      } catch {
        return { ok: false, error: 'error: cwd is outside the registered projects' };
      }
      // the kind is typed into a fresh shell as a command — re-validate here
      // even though spawn_agent already did: the remote agent.spawn RPC
      // funnels through this host path too (defense in depth). A launcher
      // the USER picked is authorized by consent: skip the allowlist, never
      // the plain-command check.
      if (kind !== undefined) {
        // explicit bare shells are never spawnable through this path — the
        // remote bridge's shell path passes undefined (audit RV-28)
        if (kind.toLowerCase() === 'shell') {
          return { ok: false, error: 'error: bare shells are never spawnable here' };
        }
        const plain = commandIsPlainLaunch(kind);
        if (!plain) return { ok: false, error: 'error: launcher command is not a plain invocation (no shell metacharacters)' };
        if (!userPicked) {
          const gateErr = await validateLauncherKind(kind, {
            getAllowedLaunchers: async () => (await settings.get()).reviewer.allowedLaunchers ?? [],
            getAgentCommand: async () => (await settings.get()).reviewer.agentCommand ?? '',
          });
          if (gateErr) return { ok: false, error: gateErr };
        }
      }
      // cwd arrives from the phone via agent.spawn — refuse anything that is
      // not an existing directory instead of spawning a shell elsewhere
      if (cwd.length > 0) {
        try {
          if (!(await stat(confined)).isDirectory()) return { ok: false, error: 'cwd is not a directory' };
        } catch {
          return { ok: false, error: 'cwd does not exist' };
        }
      }
      const agentId = sessions.allocateAgentId(rt.session);
      const tileKind: 'agent' | 'shell' = kind && kind !== 'shell' ? 'agent' : 'shell';
      const kindKey = `${rt.session.id}:${agentId}`;
      const displayName = typeof name === 'string' && name.trim().length > 0 ? name.trim().slice(0, 64) : undefined;
      rt.session.tiles.push({ agentId, cwd: confined, kind: tileKind, ...(displayName !== undefined ? { name: displayName } : {}) });
      agentKinds.set(kindKey, tileKind);
      const requestId = `spawn-${Date.now()}-${agentId}`;
      let persisted = false;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingSpawns.delete(requestId);
          // roll back the phantom tile so a timed-out spawn cannot linger
          // as a ghost agent that resurrects on the next save/restore. The
          // sequence number is NOT decremented: a late ptySpawn could then
          // reallocate the same id and collide with the rolled-back record.
          rt.session.tiles = rt.session.tiles.filter((t) => t.agentId !== agentId);
          agentKinds.delete(kindKey);
          void sessions
            .save(rt.session)
            .then(() => rt.updateSession(rt.session))
            .catch(() => undefined);
          resolve({ ok: false, error: `spawn timed out — the renderer never mounted tile for ${agentId}` });
        }, 20_000);
        pendingSpawns.set(requestId, {
          sessionId: rt.session.id,
          agentId,
          resolve: (out) => {
            // the verdict arrives from the ptySpawn outcome (success or error)
            clearTimeout(timer);
            if (out.startsWith('error')) resolve({ ok: false, error: out });
            else resolve({ ok: true, agentId });
          },
        });
        void sessions
          .save(rt.session)
          .then(() => {
            persisted = true;
          })
          .then(() => sessions.ensureAgentMailbox(rt.session.id, agentId))
          .then(() => {
            rt.updateSession(rt.session);
            mainWindow?.webContents.send(IPC.reviewerSpawnRequest, {
              sessionId: rt.session.id,
              requestId,
              agentId,
              cwd: confined,
              command: kind === 'shell' ? undefined : kind,
            } satisfies ReviewerSpawnRequest);
          })
          .catch((err: unknown) => {
            pendingSpawns.delete(requestId);
            clearTimeout(timer);
            if (!persisted) rt.session.nextAgentSeq -= 1;
            rt.session.tiles = rt.session.tiles.filter((t) => t.agentId !== agentId);
            agentKinds.delete(kindKey);
            resolve({ ok: false, error: `error: ${(err as Error).message}` });
          });
      });
    };
    const openProjectSession = async (projectPath: string): Promise<OpenedSession> => {
      let project =
        (await projects.list()).find((p) => p.path === projectPath) ??
        (await projects.add(projectPath));
      if (project.sessionId) {
        try {
          return await openSession(project.sessionId);
        } catch {
          // stale binding (session deleted) — fall through and recreate
        }
      }
      const opened = await sessions.newSession(project.name);
      project = (await projects.bindSession(projectPath, opened.session.id)) ?? project;
      opened.session.projectPath = projectPath;
      opened.session.name = project.name;
      opened.session.judge = { command: '', cwd: projectPath };
      await sessions.save(opened.session);
      const rt = registry!.open(opened.session.id, opened.session);
      refreshMenu();
      return { session: rt.session, agents: rt.session.tiles, state: rt.state };
    };

    ipcMain.handle(IPC.appInfo, (): AppInfo => ({
      version: app.getVersion(),
      shell: process.env.SHELL || '/bin/bash',
      userData: app.getPath('userData'),
      home,
    }));
/** Closes a renderer tile synchronously after a refused pty:spawn so the
 *  dead tile cannot linger and block session saves. */
function failTile(sessionId: string, tileId: string, error?: string): void {
  mainWindow?.webContents.send(IPC.tileExit, sessionId, tileId, { code: -1, ...(error !== undefined ? { error } : {}) });
}

ipcMain.handle(IPC.ptySpawn, async (_e, args: PtySpawnArgs): Promise<PtySpawnResult> => {
  // settle the reviewer's pending spawn fast (instead of a 20s timeout)
  // and close the mounted tile so it cannot block future saves
  const refuse = (why: string): Error => {
    settlePendingSpawn(args.sessionId, args.agentId, `error: ${why}`);
    failTile(args.sessionId, args.tileId, why);
    return new Error(why);
  };
  const rt = registry?.get(args.sessionId) ?? null;
  const session = rt?.session ?? null;
  if (!rt || !session) throw refuse(`no runtime for session ${args.sessionId}`);
  // a stopped session must not accept new PTYs — saves are suppressed for
  // stopped runtimes, so a spawned tile would wedge the session half-alive
  if (rt.state === 'stopped') throw refuse('session is stopped');
  // tile ids land in host maps and IPC — same internally-generated rule
  if (typeof args.tileId !== 'string' || !/^tile-\d+$/.test(args.tileId)) {
    throw refuse(`invalid tile id ${String(args.tileId)}`);
  }
  // spawn cap: the renderer may not exhaust PIDs/memory with PTYs
  if (!rt.host.has?.(args.tileId) && (rt.host.count?.() ?? 0) >= MAX_PTY_PER_SESSION) {
    throw refuse(`tile cap (${MAX_PTY_PER_SESSION}) reached`);
  }
  // agent ids are internally generated agent-<n>: anything else must
  // never reach mailbox paths (agents dir, env contract)
  if (args.agentId !== undefined && (typeof args.agentId !== 'string' || !/^agent-\d+$/.test(args.agentId))) {
    throw refuse(`invalid agent id ${args.agentId}`);
  }
  // restore passes the persisted agentId; live spawns get a fresh one.
  // An agentId that is neither a persisted tile nor a live spawn is STALE —
  // e.g. it arrived after the reviewer spawn already timed out — and must
  // not resurrect a record for an id the reviewer no longer knows about.
  let agentId = args.agentId ?? null;
  if (agentId !== null && !session.tiles.some((t) => t.agentId === agentId)) {
    throw refuse(`stale spawn for ${agentId}`);
  }
  if (agentId === null) {
    agentId = sessions.allocateAgentId(session);
    session.tiles.push({ agentId, cwd: args.cwd });
    try {
      await sessions.save(session);
    } catch (err) {
      // the id was never persisted: roll the in-memory state back so a
      // retry reuses it instead of burning the sequence
      session.tiles = session.tiles.filter((t) => t.agentId !== agentId);
      session.nextAgentSeq -= 1;
      throw refuse(`session save failed: ${(err as Error).message}`);
    }
    rt.updateSession(session);
  } else {
    // restore: keep the tile record in sync with the spawn cwd and kind.
    // A failure here must close the mounted tile like any other refusal —
    // otherwise the view keeps a dead tile with no PTY (audit PTY-05).
    try {
      session.tiles = session.tiles.map((t) =>
        t.agentId === agentId ? { ...t, cwd: args.cwd, kind: args.command && args.command.trim().length > 0 ? 'agent' : t.kind } : t,
      );
      await sessions.save(session);
      rt.updateSession(session);
    } catch (err) {
      throw refuse(`session save failed: ${(err as Error).message}`);
    }
  }
  // renderer-supplied launcher commands are gated exactly like the
  // reviewer's own spawns: a plain invocation whose first token is on the
  // effective allowlist. (Flag-level inspection is out of scope by design —
  // allowlisted launchers may carry flags; see shared/launchers.ts.)
  if (args.command !== undefined) {
    if (typeof args.command !== 'string' || !commandIsPlainLaunch(args.command)) {
      throw refuse('launcher command is not a plain invocation');
    }
    const s = await settings.get();
    const allow = effectiveAllowlist(s.reviewer.allowedLaunchers ?? [], s.reviewer.agentCommand ?? '');
    if (!allow.includes(launcherFirstToken(args.command))) {
      throw refuse(`launcher ${launcherFirstToken(args.command)} is not on the allowed list`);
    }
  }
  // the cwd must be a registered project root (or the home workspace the
  // app offers when no project is open) — never an arbitrary directory
  try {
    await confineOrThrow([...(await projectRoots()), home], args.cwd);
  } catch {
    throw refuse('cwd is outside the registered projects');
  }
  // launcher command present ⇒ an agent tile, otherwise a plain shell
  // (restored tiles fall back to their persisted kind)
  const persistedKind = session.tiles.find((t) => t.agentId === agentId)?.kind;
  agentKinds.set(`${session.id}:${agentId}`, args.command && args.command.trim().length > 0 ? 'agent' : (persistedKind ?? 'shell'));
  try {
    await sessions.ensureAgentMailbox(session.id, agentId);
  } catch (err) {
    throw refuse(`mailbox setup failed: ${(err as Error).message}`);
  }
  rt.agentToTile.set(agentId, args.tileId);
  const env = buildAgentEnv(session.id, agentId, 'agent', rt.sessionDir());
  try {
    rt.host.spawn(args.tileId, { cwd: args.cwd, cols: args.cols, rows: args.rows, envExt: env });
    sessionInfra.get(session.id)?.recorder.resize(args.tileId, args.cols, args.rows);
    if (args.command && args.command.trim().length > 0) {
      rt.host.write(args.tileId, `${args.command.trim()}\n`);
    }
    // the PTY is genuinely alive now — the reviewer's spawn verdict is real
    settlePendingSpawn(args.sessionId, agentId, `spawned agent ${agentId} (tile ${args.tileId})`);
  } catch (err) {
    // a failed spawn must surface as a spawn error to the reviewer, not
    // a success that the renderer mount ack already reported
    settlePendingSpawn(args.sessionId, agentId, `error: pty spawn failed for ${args.tileId}: ${(err as Error).message}`);
        // a failed spawn must close the tile through the normal exit path,
        // otherwise the renderer would keep a dead tile forever — and the
        // phantom tile state must not linger to resurrect on the next save
        console.error(`pty spawn failed for ${args.tileId}:`, err);
        rt.agentToTile.delete(agentId);
        agentKinds.delete(`${session.id}:${agentId}`);
        session.tiles = session.tiles.filter((t) => t.agentId !== agentId);
        try {
          await sessions.save(session);
          rt.updateSession(session);
        } catch {
          // best-effort cleanup
        }
        mainWindow?.webContents.send(IPC.tileExit, session.id, args.tileId, { code: -1 });
      }
      return { agentId };
    });
    ipcMain.on(IPC.ptyWrite, (_e, sessionId: string, tileId: string, data: string) => {
      if (typeof data !== 'string') return;
      registry?.get(sessionId)?.host.write(tileId, data);
    });
    ipcMain.on(IPC.ptyResize, (_e, sessionId: string, tileId: string, cols: number, rows: number) => {
      if (typeof cols !== 'number' || typeof rows !== 'number' || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
      registry?.get(sessionId)?.host.resize(tileId, cols, rows);
      // keep the recording's emulator in sync so scrollback wraps at the
      // real tile width (and alt-frame diffs track the real rows)
      sessionInfra.get(sessionId)?.recorder.resize(tileId, Math.floor(cols), Math.floor(rows));
    });
    ipcMain.on(IPC.ptyKill, (_e, sessionId: string, tileId: string) => {
      if (typeof sessionId !== 'string' || typeof tileId !== 'string') return;
      registry?.get(sessionId)?.host.kill(tileId);
    });

    currentTheme = ((await settings.get()).theme as ThemeId) ?? 'midnight';
    if (!THEME_IDS.includes(currentTheme)) currentTheme = 'midnight';
    const refreshMenu = (): void => {
      Menu.setApplicationMenu(null);
      mainWindow?.setMenuBarVisibility(false);
    };
    refreshMenu();
    ipcMain.handle(IPC.appQuit, () => {
      app.quit();
    });
    ipcMain.handle(IPC.projectsList, () => projects.list());
    ipcMain.handle(IPC.projectsAdd, async (): Promise<Project | null> => {
      // dialog-driven: the renderer cannot name the root it registers
      // (audit SEC-1)
      if (!mainWindow) return null;
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: 'Add project folder',
        properties: ['openDirectory'],
      });
      if (picked.canceled || picked.filePaths.length === 0) return null;
      const dir = picked.filePaths[0]!;
      const st = await stat(dir).catch(() => null);
      if (!st?.isDirectory()) return null;
      return projects.add(dir);
    });
    ipcMain.handle(IPC.projectsRemove, (_e, path: string) => projects.remove(path));
    ipcMain.handle(IPC.settingsGet, () => settings.get());
    ipcMain.handle(IPC.settingsSet, async (_e, patch: Partial<Settings>) => {
      const next = await settings.set(patch);
      // harness slots apply on reviewer restart (construction-time list) —
      // running reviewers keep theirs; just refresh the cache for the next one
      if (patch.reviewer && 'harnesses' in patch.reviewer) {
        cachedHarnesses = sanitizeHarnessSlots(next.reviewer.harnesses);
      }
      if (THEME_IDS.includes(next.theme as ThemeId)) {
        currentTheme = next.theme as ThemeId;
        refreshMenu();
      }
      // "loops hunger" applies live: every running reviewer swaps its poll
      // cadence immediately (no restart needed)
      if (patch.reviewer && 'pollSeconds' in patch.reviewer) {
        const cadence = deriveLoopCadence(next.reviewer.pollSeconds);
        for (const rt of registry?.all() ?? []) rt.reviewer.setCadence(cadence);
      }
      // every live consumer (editor prefs, explorer filter, notification
      // toggle) re-reads from this broadcast instead of re-fetching
      mainWindow?.webContents.send(IPC.settingsChanged, next);
      return next;
    });
    ipcMain.handle(IPC.settingsRevealData, async () => {
      await shell.openPath(app.getPath('userData'));
    });
    // Prompt Store: the global prompt library. Bodies are sanitized and
    // capped in the store; every mutation broadcasts so open views refresh.
    ipcMain.handle(IPC.promptsList, () => promptStore.list());
    ipcMain.handle(IPC.promptsSave, async (_e, draft: PromptDraft) => {
      if (typeof draft !== 'object' || draft === null) throw new Error('invalid prompt');
      const entry = await promptStore.save(draft);
      mainWindow?.webContents.send(IPC.promptsChanged);
      return entry;
    });
    ipcMain.handle(IPC.promptsDelete, async (_e, id: string) => {
      if (typeof id !== 'string' || id.length === 0 || id.length > 64) return false;
      const ok = await promptStore.delete(id);
      if (ok) mainWindow?.webContents.send(IPC.promptsChanged);
      return ok;
    });
    ipcMain.handle(IPC.promptsUse, async (_e, id: string) => {
      if (typeof id !== 'string' || id.length === 0 || id.length > 64) return null;
      return promptStore.use(id);
    });
    ipcMain.handle(IPC.promptsExport, async () => promptStore.exportPrompts());
    ipcMain.handle(IPC.promptsImport, async (_e, json: string) => {
      if (typeof json !== 'string') return { imported: 0, errors: ['invalid input'] };
      return promptStore.importPrompts(json);
    });
    initNotify({
      getWindow: () => mainWindow,
      isEnabled: async () => (await settings.get()).notifications?.enabled ?? true,
      // no DBus / unsupported platform: log it — the in-app notice path has
      // no session-less channel, and the reviewer transcript still shows the
      // event when the user looks
      onUnsupported: (title, body) => console.log(`[notify:unsupported] ${title}: ${body}`),
    });
    // programmatic theme switch — persists and re-broadcasts through the
    // exact native-menu path (used by the E2E driver's theme walk)
    ipcMain.handle(IPC.themeApply, async (_e, id: unknown) => {
      if (typeof id !== 'string' || !THEME_IDS.includes(id as ThemeId)) return;
      const next = await settings.set({ theme: id as ThemeId });
      currentTheme = next.theme as ThemeId;
      refreshMenu();
      mainWindow?.webContents.send(IPC.menuTheme, id);
    });
    ipcMain.handle(IPC.sessionsList, async () => {
      const list = await sessions.list();
      return list.map((s) => ({ ...s, state: registry?.get(s.id)?.state ?? 'stopped' }));
    });
    ipcMain.handle(IPC.sessionNew, async (_e, name: string): Promise<OpenedSession> => {
      const opened = await sessions.newSession(name);
      const rt = registry!.open(opened.session.id, opened.session);
      refreshMenu();
      return { session: rt.session, agents: rt.session.tiles, state: rt.state };
    });
    ipcMain.handle(IPC.sessionSaveAs, async (_e, id: string, name: string) => {
      const session = await sessions.rename(id, name);
      registry?.get(id)?.updateSession(session);
      refreshMenu();
      return session;
    });
    ipcMain.handle(IPC.sessionOpen, (_e, id: string) => openSession(id));
    ipcMain.handle(IPC.sessionDelete, async (_e, id: string) => {
      deletedSessions.add(id);
      // settle any in-flight spawn for this session before the dir vanishes
      for (const [requestId, pending] of pendingSpawns) {
        if (pending.sessionId === id) {
          pendingSpawns.delete(requestId);
          pending.resolve('error: session deleted');
        }
      }
      registry?.teardown(id);
      sessionInfra.get(id)?.persist.dispose();
      sessionInfra.delete(id);
      await sessions.delete(id);
      refreshMenu();
    });
    ipcMain.handle(IPC.sessionStop, (_e, id: string) => {
      registry?.stop(id);
      remote?.publish({ type: 'session.state', sessionId: id, alive: false });
    });
    ipcMain.handle(IPC.sessionStart, (_e, id: string) => {
      registry?.start(id);
      remote?.publish({ type: 'session.state', sessionId: id, alive: true });
    });
    ipcMain.handle(IPC.sessionExportBundle, async (_e, id: string): Promise<BundleResult> => {
      // the id reaches stat()/tar argv — confine it to a real session id
      if (typeof id !== 'string' || !/^s-[a-z0-9-]+$/.test(id)) return { ok: false, canceled: false, error: 'invalid session id' };
      if (!mainWindow) return { ok: false, canceled: true, error: '' };
      const session = await sessions.load(id).catch(() => null);
      const base = (session?.name ?? id).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
      const picked = await dialog.showSaveDialog(mainWindow, {
        title: 'Export session bundle',
        defaultPath: `fraktole-session-${base}.tar.gz`,
        filters: [{ name: 'Fraktole session bundle', extensions: ['tar.gz'] }],
      });
      if (picked.canceled || !picked.filePath) return { ok: false as const, canceled: true as const, error: '' };
      return exportSessionBundle(sessionsRoot, id, picked.filePath);
    });
    ipcMain.handle(IPC.sessionImportBundle, async (): Promise<BundleResult> => {
      if (!mainWindow) return { ok: false, canceled: true, error: '' };
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: 'Import session bundle',
        filters: [{ name: 'Fraktole session bundle', extensions: ['tar.gz'] }],
        properties: ['openFile'],
      });
      if (picked.canceled || picked.filePaths.length === 0) {
        return { ok: false as const, canceled: true as const, error: '' };
      }
      const res = await importSessionBundle(sessionsRoot, picked.filePaths[0]!);
      if (!res.ok || !res.session) return res;
      registry!.open(res.session.id, res.session);
      refreshMenu();
      return { ok: true as const, session: res.session };
    });
    ipcMain.handle(IPC.projectOpen, (_e, path: string): Promise<OpenedSession> => {
      const run = projectOpenQueue.then(async (): Promise<OpenedSession> => {
        const project = await projects.add(path);
        // key by the resolved root (git toplevel), not the raw path
        const key = project.path;
        const pending = pendingProjectOpens.get(key);
        if (pending) return pending;
        const p = openProjectSession(key);
        pendingProjectOpens.set(key, p);
        try {
          return await p;
        } finally {
          pendingProjectOpens.delete(key);
        }
      });
      projectOpenQueue = run.catch(() => undefined);
      return run;
    });
    ipcMain.handle(IPC.sessionSave, async (_e, sessionId: string, payload: SessionSavePayload) => {
      if (deletedSessions.has(sessionId)) return null;
      const rt = registry?.get(sessionId) ?? null;
      const session = rt?.session ?? null;
      if (!session) return null;
      // a stopped session's view empties out as its PTYs die; its saves are
      // stop artifacts and must not clobber the persisted arrangement
      if (rt?.state === 'stopped') return session;
      // validate the payload BEFORE mutating anything: a malformed save must
      // not leave memory and disk diverging until the next save
      if (!Array.isArray(payload.agents)) return session;
      const kept = new Set(payload.agents.filter((a): a is string => typeof a === 'string'));
      // an untrusted/lagging tree is sanitized and must reference only known
      // agents; otherwise the previous tree survives (audit REN-14/PTY-31)
      const sanitizedTree = sanitizeSerNode(payload.tree);
      if (sanitizedTree !== null && serNodeAgentIds(sanitizedTree).every((a) => kept.has(a))) {
        session.tree = sanitizedTree;
      } else if (payload.tree === null || payload.tree === undefined) {
        session.tree = null;
      }
      // null clears the persisted value (user unzoomed/unfocused), undefined
      // means "not part of this payload"
      if (payload.zoomedAgentId !== undefined) {
        session.zoomedAgentId = payload.zoomedAgentId !== null && kept.has(payload.zoomedAgentId) ? payload.zoomedAgentId : undefined;
      }
      if (payload.focusedAgentId !== undefined) {
        session.focusedAgentId = payload.focusedAgentId !== null && kept.has(payload.focusedAgentId) ? payload.focusedAgentId : undefined;
      }
      // an explicit judgeCwd (including null/'') is the clear signal; an
      // undefined payload means "not part of this save". A path outside the
      // registered roots is refused — judgeCwd drives the fork source and
      // the reviewer cwd (SEC-4).
      if (payload.judgeCwd !== undefined) {
        if (payload.judgeCwd && payload.judgeCwd.length > 0) {
          try {
            const cwd = await confineOrThrow([...(await projectRoots()), home], payload.judgeCwd);
            session.judge = { command: '', cwd };
          } catch {
            // keep the previous judge rather than persisting an escape
          }
        } else {
          session.judge = null;
        }
      }
      // launcher commands per agent: a restored agent tile must boot its
      // harness, not come back as a bare shell (audit REN-09)
      if (payload.commands !== undefined && typeof payload.commands === 'object') {
        for (const t of session.tiles) {
          const cmd = payload.commands[t.agentId];
          if (typeof cmd === 'string' && cmd.length > 0 && cmd.length <= 256 && commandIsPlainLaunch(cmd)) {
            t.command = cmd;
            if (t.kind === undefined) t.kind = 'agent';
          }
        }
      }
      // prunes agents closed since the last save; mailboxes stay on disk.
      // A live PTY must never be orphaned from its agent mapping by a
      // lagging renderer snapshot (audit PTY-31).
      const infra = sessionInfra.get(session.id);
      session.tiles = session.tiles.filter((t) => kept.has(t.agentId));
      for (const agentId of [...(rt?.agentToTile.keys() ?? [])]) {
        if (kept.has(agentId)) continue;
        const tileId = rt?.agentToTile.get(agentId) ?? null;
        if (tileId !== null && infra?.host?.has(tileId)) continue;
        rt?.agentToTile.delete(agentId);
      }
      await sessions.save(session);
      rt?.updateSession(session);
      if (payload.scrollback) {
        const sessionDir = rt?.sessionDir() ?? join(sessionsRoot, session.id);
        const infra = sessionInfra.get(session.id);
        const persist = infra?.persist;
        const recorder = infra?.recorder;
        await mkdir(join(sessionDir, 'scrollback'), { recursive: true });
        for (const [agentId, lines] of Object.entries(payload.scrollback)) {
          // keys land in a path join — accept only internally-generated ids
          if (!/^agent-\d+$/.test(agentId)) continue;
          // prefer the live recorder (the same source read_scrollback reads) so
          // the on-disk fallback matches the live view; fall back to the
          // renderer's captured lines only when the recorder has nothing.
          const tileId = rt?.agentToTile.get(agentId) ?? null;
          const live = recorder && tileId ? recorder.full(tileId) : [];
          const finalLines = live.length > 0 ? live : (lines as string[]);
          if (persist && tileId) {
            await persist.flushTile(tileId, finalLines);
          } else {
            // atomic fallback write: a torn JSON here would read back as "no
            // history" (audit PTY-14)
            const target = join(sessionDir, 'scrollback', `${agentId}.json`);
            const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
            try {
              await writeFile(tmp, JSON.stringify({ lines: finalLines }), 'utf8');
              await rename(tmp, target);
            } catch (err) {
              console.error(`scrollback fallback write failed for ${agentId}:`, err);
            }
          }
        }
      }
      return session;
    });
    ipcMain.handle(IPC.reviewerEnsure, async (_e, sessionId: string): Promise<boolean> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return false;
      return rt.ensureReviewer();
    });
    ipcMain.handle(IPC.reviewerPrompt, async (_e, sessionId: string, text: string): Promise<boolean> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt || text.trim().length === 0) return false;
      return rt.reviewer.prompt(text);
    });
    ipcMain.handle(IPC.reviewerSetGoal, async (_e, sessionId: string, text: string | null): Promise<void> => {
      const rt = registry?.get(sessionId) ?? null;
      await rt?.reviewer.setGoal(typeof text === 'string' && text.trim().length > 0 ? text.trim() : null);
    });
    ipcMain.handle(IPC.reviewerAutonomy, async (_e, sessionId: string, variant: unknown, mode: 'auto' | 'fresh' = 'auto'): Promise<{ ok: boolean; error?: string }> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return { ok: false, error: 'no session runtime' };
      if (variant === null || variant === undefined) {
        // leaving auto-compose ends its run: the goal must not stay armed
        // and keep the loop carrier spending tokens (audit RUN-4)
        await rt.reviewer.setVariant(null);
        await rt.reviewer.setGoal(null);
        return { ok: true };
      }
      if (typeof variant !== 'string' || !AUTONOMY_VARIANTS.includes(variant as AutonomyVariant)) {
        return { ok: false, error: 'unknown autonomous variant' };
      }
      return rt.reviewer.startAutonomy(variant as AutonomyVariant, mode === 'fresh' ? 'fresh' : 'auto');
    });
    ipcMain.handle(
      IPC.reviewerResumable,
      async (_e, sessionId: string, variant: unknown): Promise<{ resumable: boolean; goalText: string | null }> => {
        const rt = registry?.get(sessionId) ?? null;
        if (!rt || typeof variant !== 'string' || !AUTONOMY_VARIANTS.includes(variant as AutonomyVariant)) {
          return { resumable: false, goalText: null };
        }
        return rt.reviewer.resumableRun(variant as AutonomyVariant);
      },
    );
    ipcMain.handle(IPC.reviewerSummarize, async (_e, sessionId: string): Promise<{ ok: boolean; error?: string }> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return { ok: false, error: 'no session runtime' };
      return rt.reviewer.summarizeSession();
    });
    ipcMain.handle(IPC.reviewerAnswer, async (_e, sessionId: string, askId: string, answer: string): Promise<void> => {
      const rt = registry?.get(sessionId) ?? null;
      rt?.reviewer.answerQuestion(askId, answer);
    });
    ipcMain.handle(IPC.reviewerKillNow, async (_e, sessionId: string, agentId: string): Promise<string> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return 'error: no runtime for session';
      return rt.reviewer.killAgentNow(agentId);
    });
    ipcMain.handle(
      IPC.reviewerSpawnResult,
      async (_e, sessionId: string, requestId: string, payload: { tileId: string | null; agentId: string | null }): Promise<void> => {
        const pending = pendingSpawns.get(requestId);
        if (!pending) {
          // No pending spawn for this requestId: the verdict was already
          // settled by the real ptySpawn outcome, or the spawn timed out and
          // the timeout path already rolled the phantom tile back. Filtering
          // tiles here again would delete a LIVE agent whose ptySpawn simply
          // won the race against this ack.
          return;
        }
        if (!payload?.tileId) {
          // the renderer could not mount the tile — fail immediately
          pendingSpawns.delete(requestId);
          pending.resolve(`error: the renderer could not mount the tile for ${payload?.agentId ?? '?'}`);
          return;
        }
        // Mount succeeded — keep the pending spawn open: the "spawned" verdict
        // must wait for the real PTY spawn (ptySpawn). Resolving here would
        // report a false success before the shell actually exists, and a
        // failed ptySpawn would leave the reviewer believing an agent lives.

      },
    );
    ipcMain.handle(
      IPC.testState,
      async (_e, sessionId: string, requestId: string, state: TestPageState): Promise<void> => {
        const pending = pendingTestReads.get(requestId);
        if (!pending) return;
        pendingTestReads.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(
          JSON.stringify({
            url: state.url,
            title: state.title,
            loading: state.loading,
            consoleErrors: state.consoleErrors,
            console: (state.console ?? []).slice(-20),
          }),
        );
      },
    );
    ipcMain.handle(
      IPC.testScreenshot,
      async (_e, sessionId: string, requestId: string, dataUrl: string | null): Promise<void> => {
        const pending = pendingTestShots.get(requestId);
        if (!pending) return;
        pendingTestShots.delete(requestId);
        clearTimeout(pending.timer);
        if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
          pending.resolve('error: the test tab is not visible — open it first (open_test_page)');
          return;
        }
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        const buf = Buffer.from(base64, 'base64');
        if (buf.length > 8 * 1024 * 1024) {
          pending.resolve('error: screenshot too large');
          return;
        }
        const rt = registry?.get(sessionId) ?? null;
        if (!rt) {
          pending.resolve('error: no runtime for session');
          return;
        }
        const shotsDir = join(rt.sessionDir(), 'reviewer', 'shots');
        await mkdir(shotsDir, { recursive: true });
        const file = join(shotsDir, `shot-${Date.now()}.png`);
        try {
          await writeFile(file, buf);
          pending.resolve(`saved ${file} (${buf.length} bytes)`);
        } catch (err) {
          pending.resolve(`error: ${(err as Error).message}`);
        }
      },
    );
    ipcMain.handle(IPC.reviewerStop, async (_e, sessionId: string): Promise<void> => {
      const rt = registry?.get(sessionId) ?? null;
      // full stop, not just cancel(): abort the provider call, stop the
      // loop carrier, clear the queue and set status 'stopped' — the loop
      // cannot re-awaken on its own
      rt?.reviewer.stop();
    });
    ipcMain.handle(IPC.reviewerRestart, async (_e, sessionId: string): Promise<boolean> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return false;
      return rt.reviewer.restart();
    });
    ipcMain.handle(IPC.reviewerCompact, async (_e, sessionId: string): Promise<void> => {
      const rt = registry?.get(sessionId) ?? null;
      rt?.reviewer.compact();
    });
    ipcMain.handle(IPC.reviewerTranscript, async (_e, sessionId: string): Promise<ReviewerEntry[]> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return [];
      return rt.reviewer.conversation;
    });
    ipcMain.handle(
      IPC.reviewerListModels,
      async (_e, opts: { adapter: 'openai' | 'anthropic' | 'ollama'; apiKey: string; baseUrl: string; keyless?: boolean }): Promise<string[]> => {
        const key = typeof opts?.apiKey === 'string' ? opts.apiKey.trim() : '';
        // keyless local OpenAI-compatible servers (llama.cpp, LM Studio, vLLM)
        // must not be gated behind a key the catalog says they don't need
        if (opts?.adapter !== 'ollama' && opts?.keyless !== true && key.length === 0) return [];
        return listModels({ adapter: opts.adapter, apiKey: key, baseUrl: typeof opts?.baseUrl === 'string' ? opts.baseUrl : '' });
      },
    );
    // live provider health for the model section: probe state + real context
    // window + model inventory in one round trip; everything is fail-benign
    ipcMain.handle(IPC.reviewerProbe, async (_e, opts: ReviewerProbeArgs): Promise<ReviewerProbeResult> => {
      const adapter = opts?.adapter;
      const baseUrl = typeof opts?.baseUrl === 'string' ? opts.baseUrl : '';
      const model = typeof opts?.model === 'string' ? opts.model : '';
      const key = typeof opts?.apiKey === 'string' ? opts.apiKey.trim() : '';
      if (adapter !== 'openai' && adapter !== 'anthropic' && adapter !== 'ollama') {
        return { state: 'unreachable', models: [], detail: 'unknown adapter' };
      }
      if (adapter === 'anthropic') {
        const models = key.length > 0 ? await listModels({ adapter, apiKey: key, baseUrl }) : [];
        return { state: key.length > 0 ? 'ok' : 'unreachable', models, kind: 'unknown', detail: key.length > 0 ? 'anthropic cloud — no local probe' : 'no API key' };
      }
      if (adapter !== 'ollama' && opts?.keyless !== true && key.length === 0) {
        return { state: 'unreachable', models: [], detail: 'no API key' };
      }
      const [probe, models] = await Promise.all([
        probeLocalServer({ adapter: adapter as 'openai' | 'ollama', baseUrl, model }),
        listModels({ adapter, apiKey: key, baseUrl }),
      ]);
      return { state: probe.state, serverContext: probe.contextTokens, models, kind: probe.kind, detail: probe.detail };
    });
    ipcMain.handle(IPC.scrollbackGet, async (_e, sessionId: string, agentId: string): Promise<string[] | null> => {
      const rt = registry?.get(sessionId) ?? null;
      // agentId lands in a path join — same single-component rule the remote
      // bridge applies to phone-supplied ids (readDiskScrollback)
      if (!rt || typeof agentId !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(agentId)) return null;
      try {
        const raw = await readFile(join(rt.sessionDir(), 'scrollback', `${agentId}.json`), 'utf8');
        const parsed = JSON.parse(raw) as { lines?: string[] };
        return Array.isArray(parsed.lines) ? parsed.lines : null;
      } catch {
        return null;
      }
    });

    // file editor backend
    ipcMain.handle(IPC.fsListDir, async (_e, path: string): Promise<FsEntry[]> => {
      const roots = await projectRoots();
      const scoped = await confineOrThrow(roots, path);
      const entries = await readdir(scoped, { withFileTypes: true });
      const out: FsEntry[] = [];
      for (const e of entries) {
        const full = join(scoped, e.name);
        // a symlink whose real target escapes the project roots must not be
        // listed (its size/existence would leak outside paths — audit FS-1)
        if (e.isSymbolicLink() && (await confinePath(roots, full)) === null) continue;
        let isDir = e.isDirectory();
        let size = 0;
        try {
          const st = await stat(full);
          isDir = st.isDirectory();
          size = st.size;
        } catch {
          // broken symlink or unreadable entry — skip it
          continue;
        }
        out.push({ name: e.name, path: full, isDir, size });
      }
      out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
      return out;
    });
    ipcMain.handle(IPC.fsReadFile, async (_e, path: string): Promise<{ content: string; size: number }> => {
      const scoped = await confineOrThrow(await projectRoots(), path);
      const st = await stat(scoped);
      if (st.size > 4 * 1024 * 1024) throw new Error('file too large');
      return { content: await readFile(scoped, 'utf8'), size: st.size };
    });
    ipcMain.handle(IPC.fsWriteFile, async (_e, path: string, content: string): Promise<void> => {
      if (typeof content !== 'string') throw new Error('invalid file content');
      const scoped = await confineOrThrow(await projectRoots(), path);
      // write-like operations additionally reject symlink components so a
      // swapped link cannot redirect the write (audit SEC-5)
      if ((await confineNoSymlinks(await projectRoots(), path)) === null) throw new Error('path is outside the registered projects');
      fileWatches.suppress(scoped);
      await writeAtomic(scoped, content);
      await invalidateQuickOpen();
    });
    ipcMain.handle(IPC.fsStat, async (_e, path: string): Promise<FsStat> => {
      const scoped = await confineOrThrow(await projectRoots(), path);
      const st = await stat(scoped);
      return { path: scoped, isDir: st.isDirectory(), isFile: st.isFile(), size: st.size, mtimeMs: st.mtimeMs };
    });
    // quick-open cache invalidation: any fs mutation under a root must not
    // keep serving a stale file list (audit PERF-4)
    const invalidateQuickOpen = async (): Promise<void> => {
      for (const r of await projectRoots()) invalidateProjectFiles(r);
    };
    const fileWatches = new FileWatchRegistry((path) => mainWindow?.webContents.send(IPC.fsFileChanged, path));
    ipcMain.handle(IPC.fsWatchFile, async (_e, path: string) => fileWatches.watch(await confineOrThrow(await projectRoots(), path)));
    ipcMain.handle(IPC.fsUnwatchFile, async (_e, path: string) => {
      const scoped = await confineOrThrow(await projectRoots(), path);
      fileWatches.unwatch(scoped);
    });
    ipcMain.handle(IPC.fsMkdir, async (_e, dirPath: string) => {
      const roots = await projectRoots();
      if ((await confineNoSymlinks(roots, dirPath)) === null) throw new Error('path is outside the registered projects');
      await mkdirForUser(await confineOrThrow(roots, dirPath));
      await invalidateQuickOpen();
    });
    ipcMain.handle(IPC.fsCreateFile, async (_e, path: string) => {
      const roots = await projectRoots();
      if ((await confineNoSymlinks(roots, path)) === null) throw new Error('path is outside the registered projects');
      await createFileForUser(await confineOrThrow(roots, path));
      await invalidateQuickOpen();
    });
    ipcMain.handle(IPC.fsRename, async (_e, from: string, to: string) => {
      const roots = await projectRoots();
      const fromScoped = await confineOrThrow(roots, from);
      const toScoped = await confineOrThrow(roots, to);
      if ((await confineNoSymlinks(roots, from)) === null || (await confineNoSymlinks(roots, to)) === null) {
        throw new Error('path is outside the registered projects');
      }
      fileWatches.suppress(fromScoped);
      fileWatches.suppress(toScoped);
      await renameForUser(fromScoped, toScoped);
      await invalidateQuickOpen();
    });
    ipcMain.handle(IPC.fsTrash, async (_e, path: string) => {
      const roots = await projectRoots();
      if ((await confineNoSymlinks(roots, path)) === null) throw new Error('path is outside the registered projects');
      await trashForUser(await confineOrThrow(roots, path));
      await invalidateQuickOpen();
    });
    ipcMain.handle(IPC.gitStatus, async (_e, projectPath: string) => {
      const scoped = await confineOrThrow(await projectRoots(), projectPath);
      return collectGitStatus(scoped);
    });
    // the newest query wins: a superseded search is aborted instead of
    // running to its 4s timeout (audit REN-28)
    let activeSearch: AbortController | null = null;
    ipcMain.handle(IPC.searchProject, async (_e, root: string, query: string) => {
      if (typeof query !== 'string') throw new Error('invalid search query');
      const scoped = await confineOrThrow(await projectRoots(), root);
      activeSearch?.abort();
      const controller = new AbortController();
      activeSearch = controller;
      try {
        return await searchProject(scoped, query, controller.signal);
      } finally {
        if (activeSearch === controller) activeSearch = null;
      }
    });
    ipcMain.handle(IPC.usageHistory, async (_e, sessionId: string) => {
      if (typeof sessionId !== 'string' || !/^s-[a-z0-9-]+$/.test(sessionId)) return [];
      try {
        return await new UsageLog(join(sessionsRoot, sessionId, 'reviewer')).read();
      } catch {
        return [];
      }
    });

    ipcMain.handle(IPC.pickFolder, async () => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Add a project folder',
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    });

    // quick-open palette: bounded file list for a project root (confined
    // to registered roots like every other fs channel — audit REN-01)
    ipcMain.handle(IPC.projectsFiles, async (_e, root: string): Promise<Array<{ name: string; path: string }>> => {
      if (typeof root !== 'string' || root.length === 0) return [];
      const scoped = await confinePath(await projectRoots(), root);
      if (scoped === null) return [];
      return listProjectFiles(scoped);
    });

    // terminal copy/paste: the native clipboard, not the renderer's
    // permission-gated navigator.clipboard
    ipcMain.handle(IPC.clipboardWrite, (_e, text: string): void => {
      clipboard.writeText(String(text));
    });
    ipcMain.handle(IPC.clipboardRead, (): string => clipboard.readText());

    // ————— remote bridge (docs/remote-protocol.md) —————

    const remoteStore = new RemoteStore(join(app.getPath('userData'), 'remote'));
    let remote: RemoteBridge | null = null;
    /** Last bridge start failure, surfaced in the Remote tab. */
    let remoteError: string | null = null;

    const liveTileOf = (agentId: string, sessionId?: string): { recorder: TileRecorder; tileId: string } | null => {
      for (const rt of registry?.all() ?? []) {
        // scoped lookup: agent ids repeat across sessions (agent-1 exists in
        // every session), so without a session filter this would return the
        // first matching runtime's tile — often the wrong session's
        if (sessionId !== undefined && rt.id !== sessionId) continue;
        const tileId = rt.agentToTile.get(agentId);
        if (tileId) {
          const infra = sessionInfra.get(rt.id);
          if (infra) return { recorder: infra.recorder, tileId };
        }
      }
      return null;
    };

    /** On-disk scrollback fallback for tiles with no live runtime. */
    const readDiskScrollback = async (agentId: string, tail: number, sessionId?: string): Promise<string> => {
      // agentId comes from the phone — keep it a single path component so it
      // can never traverse out of the session scrollback dir (the live path
      // above is a map lookup and cannot traverse, this one builds a path)
      if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(agentId)) {
        return '';
      }
      // a phone-supplied sessionId skips the O(sessions) index/readdir scan:
      // read that one directory directly, then fall back to the scan only
      // when it misses (audit PTY-29)
      if (sessionId !== undefined) {
        try {
          const raw = await readFile(join(sessionsRoot, sessionId, 'scrollback', `${agentId}.json`), 'utf8');
          const parsed = JSON.parse(raw) as { lines?: string[] };
          const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
          return lines.slice(Math.max(0, lines.length - tail)).join('\n');
        } catch {
          // unknown session/dir — fall through to the index scan
        }
      }
      const list = await sessions.list();
      for (const s of list) {
        if (sessionId !== undefined && s.id !== sessionId) continue;
        if (!(await sessions.listAgentIds(s.id)).includes(agentId)) continue;
        try {
          const raw = await readFile(join(sessionsRoot, s.id, 'scrollback', `${agentId}.json`), 'utf8');
          const parsed = JSON.parse(raw) as { lines?: string[] };
          const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
          return lines.slice(Math.max(0, lines.length - tail)).join('\n');
        } catch {
          return '';
        }
      }
      return '';
    };

    const readScrollback = async (agentId: string, tail = 500, sessionId?: string): Promise<string> => {
      const live = liveTileOf(agentId, sessionId);
      if (live) return live.recorder.tail(live.tileId, tail).join('\n');
      return readDiskScrollback(agentId, tail, sessionId);
    };

    const activeRuntime = (): SessionRuntime | null => {
      const id = registry?.active ?? null;
      return id ? (registry?.get(id) ?? null) : null;
    };

    const makeRemoteBackend = (): RemoteBackend => ({
      serverName: 'Fraktole',
      version: app.getVersion(),
      listSessions: async (): Promise<SessionRow[]> => {
        const list = await sessions.list();
        return list.map((s) => ({
          id: s.id,
          name: s.name,
          project: s.projectPath ?? '',
          alive: (registry?.get(s.id)?.state ?? 'stopped') !== 'stopped',
          tileCount: s.agentCount,
          updatedAt: s.updatedAt,
        }));
      },
      listTiles: async (sessionId: string): Promise<TileRow[]> => {
        const session = await sessions.load(sessionId);
        const rt = registry?.get(sessionId) ?? null;
        const infra = sessionInfra.get(sessionId) ?? null;
        const now = Date.now();
        return session.tiles.map((t) => {
          const tileId = rt?.agentToTile.get(t.agentId) ?? null;
          const summary = tileId && infra ? infra.recorder.summary(tileId) : { lines: 0, lastAt: 0 };
          return {
            id: t.agentId,
            name: t.name ?? t.agentId,
            kind: agentKinds.get(`${sessionId}:${t.agentId}`) ?? t.kind ?? 'agent',
            cwd: t.cwd,
            lines: summary.lines,
            lastActiveAgoSec: summary.lastAt > 0 ? Math.max(0, Math.floor((now - summary.lastAt) / 1000)) : 0,
          };
        });
      },
      liveTileOf: async (sessionId: string, agentId: string): Promise<string | null> => {
        const rt = registry?.get(sessionId) ?? null;
        return rt?.agentToTile.get(agentId) ?? null;
      },
      readScrollback: async (agentId: string, tail?: number, sessionId?: string): Promise<string> =>
        readScrollback(agentId, typeof tail === 'number' && tail > 0 ? Math.min(tail, 2000) : 500, sessionId),
      snapshot: async (agentId: string, sessionId?: string): Promise<string> => readScrollback(agentId, 200, sessionId),
      sendTask: async ({ sessionId, agentId, kind: _kind, body }) => {
        // scope to the phone-supplied session: agent ids are per-session, so
        // resolving by id alone could deliver to another session (REM-04)
        const rt = registry?.get(sessionId) ?? null;
        if (!rt) return { ok: false, error: `unknown session ${sessionId}` };
        if (!rt.session.tiles.some((t) => t.agentId === agentId)) return { ok: false, error: `unknown agent ${agentId}` };
        const id = messageId();
        const delivered = await rt.router.sendFromOrchestrator({
          id,
          from: ORCHESTRATOR_ID,
          to: agentId,
          kind: 'task',
          body,
          at: Date.now(),
        });
        return delivered ? { ok: true, messageId: id } : { ok: false, error: 'message rejected by the mailbox' };
      },
      listMessages: async (limit?: number): Promise<MessageRow[]> => {        const rt = activeRuntime() ?? null;
        // read + parse one session's messages.jsonl
        const readSessionMessages = async (sessionId: string): Promise<MessageRow[]> => {
          const parsed = await readMessagesJsonl(sessionsRoot, sessionId);
          const out: MessageRow[] = [];
          for (const line of parsed) {
            const m = line as { kind?: string; from?: string; to?: string; body?: string; at?: number };
            if (typeof m.kind !== 'string' || typeof m.body !== 'string') continue;
            out.push({ kind: m.kind as MessageRow['kind'], from: m.from ?? '', to: m.to ?? '', body: m.body, ts: m.at ?? 0 });
          }
          return out.sort((a, b) => b.ts - a.ts);
        };
        const rows = (rt
          ? await rt.router.listMessages(rt.session.id)
          : await (async () => {
              const list = await sessions.list();
              if (list.length === 0) return [];
              // no active runtime: merge EVERY session's history so the phone's
              // global feed is not silently one arbitrary (most-recently-touched)
              // session's messages
              const allRows: MessageRow[] = [];
              for (const session of list) {
                allRows.push(...(await readSessionMessages(session.id)));
              }
              return allRows.sort((a, b) => b.ts - a.ts);
            })()) as MessageRow[];
        return rows.slice(0, typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : 50).map((m) => ({
          kind: m.kind,
          from: m.from,
          to: m.to,
          body: m.body,
          ts: m.ts,
        }));
      },
      listPrompts: async () => {
        const rows = await promptStore.list();
        return rows.map((p) => ({ id: p.id, name: p.name, body: p.body, tags: p.tags, useCount: p.useCount }));
      },
      exportPrompts: async () => promptStore.exportPrompts(),
      importPrompts: async (json: string) => promptStore.importPrompts(json),
      spawnAgent: async ({ sessionId, cwd, kind, name }) => {
        let rt = sessionId !== undefined ? (registry?.get(sessionId) ?? null) : activeRuntime();
        if (!rt && sessionId !== undefined) return { ok: false, error: `unknown session ${sessionId}` };
        if (!rt) {
          const list = await sessions.list();
          if (list.length === 0) return { ok: false, error: 'no session available' };
          const session = await sessions.load(list[0]!.id);
          rt = registry!.open(session.id, session);
          refreshMenu();
        }
        // user-driven remote spawn: consent is the button press itself —
        // bypass the harness-only gate (plain-command check still applies)
        const res = await spawnAgentInSession(rt, kind === 'shell' ? undefined : kind, cwd ?? judgeCwdFor(rt.session), true, name);
        return res.ok ? { ok: true, agentId: res.agentId } : { ok: false, error: res.error };
      },
    });

    const buildRemoteStatus = async (): Promise<RemoteStatus> => {
      const state = await remoteStore.get();
      const code = remote?.pairingCode ?? null;
      const devices = await remote?.devices() ?? [];
      return {
        enabled: state.enabled,
        port: state.port,
        listening: remote?.listening ?? false,
        error: remoteError,
        fingerprint: remote?.fingerprint256 ?? null,
        lanIps: lanIps(),
        pairingCode: code?.code ?? null,
        pairingCodeExpiresAt: code?.expiresAt ?? null,
        devices: devices.map((d) => ({
          deviceId: d.deviceId,
          name: d.name,
          connected: d.connected,
          createdAt: d.createdAt,
          lastSeen: d.lastSeen,
        })),
      };
    };

    const pushRemoteStatus = (): void => {
      void buildRemoteStatus().then((status) => mainWindow?.webContents.send(IPC.remoteStatus, status));
    };

    const enableRemote = async (): Promise<void> => {
      const state = await remoteStore.get();
      remote?.stop();
      remote = new RemoteBridge({
        port: state.port,
        backend: makeRemoteBackend(),
        store: remoteStore,
        certDir: join(app.getPath('userData'), 'remote'),
        logger: (line) => console.log(line),
        onStatusChange: pushRemoteStatus,
      });
      try {
        await remote.start();
        remoteError = null;
      } catch (err) {
        remoteError = (err as Error).message;
        // a failed instance must not stay assigned: remoteGetState's
        // `enabled && !remote` retry path would never fire again (REM-28)
        remote?.stop();
        remote = null;
        throw err;
      }
      pushRemoteStatus();
    };

    const disableRemote = (): void => {
      remote?.stop();
      remote = null;
      pushRemoteStatus();
    };

    ipcMain.handle(IPC.remoteGetState, async (): Promise<RemoteStatus> => {
      // boot-time catch-up: honors a persisted/environment enable
      const state = await remoteStore.get();
      if (state.enabled && !remote) {
        try {
          await enableRemote();
        } catch (err) {
          console.error('remote bridge start failed:', err);
          pushRemoteStatus();
        }
      }
      return buildRemoteStatus();
    });
    ipcMain.handle(IPC.remoteSetEnabled, async (_e, enabled: unknown): Promise<RemoteStatus> => {
      const on = enabled === true || enabled === 'true';
      await remoteStore.setEnabled(on);
      if (on) {
        try {
          await enableRemote();
        } catch (err) {
          console.error('remote bridge start failed:', err);
        }
      } else {
        disableRemote();
      }
      return buildRemoteStatus();
    });
    ipcMain.handle(IPC.remoteSetPort, async (_e, port: unknown): Promise<RemoteStatus> => {
      // only a sane port is worth persisting; garbage must not reset the
      // user's configured port to the default
      const numeric = typeof port === 'number' ? port : Number(port);
      if (!Number.isInteger(numeric) || numeric <= 0 || numeric >= 65536) return buildRemoteStatus();
      await remoteStore.setPort(numeric);
      if (remote?.listening) {
        try {
          await enableRemote();
        } catch (err) {
          console.error('remote bridge restart failed:', err);
        }
      }
      return buildRemoteStatus();
    });
    ipcMain.handle(IPC.remoteRevokeDevice, async (_e, deviceId: string): Promise<boolean> => {
      const revoked = await remoteStore.revokeDevice(deviceId);
      if (revoked) {
        remote?.revokeDevice(deviceId);
        pushRemoteStatus();
      }
      return revoked;
    });
    // keep the Remote tab's last-seen times fresh
    const remoteHeartbeat = setInterval(() => {
      if (remote?.listening) pushRemoteStatus();
    }, 30_000);
    remoteHeartbeat.unref();

    // quit flush: the renderer's beforeunload save is fire-and-forget async
    // IPC that races window teardown, so the LAST writes must happen here —
    // a final scrollback flush per live tile plus one session save — before
    // any PTY dies. Best-effort: quitting is never blocked by a flush error.
    let quitting = false;
    app.on('will-quit', (event) => {
      if (quitting) return;
      event.preventDefault();
      quitting = true;
      const deadline = (ms: number): Promise<void> =>
        new Promise((resolve) => {
          const t = setTimeout(resolve, ms);
          t.unref();
        });
      void Promise.race([
        (async () => {
          for (const rt of registry?.all() ?? []) {
            try {
              const infra = sessionInfra.get(rt.session.id);
              for (const [, tileId] of rt.agentToTile) {
                const lines = infra?.recorder.full(tileId) ?? [];
                if (infra?.persist && lines.length > 0) await infra.persist.flushTile(tileId, lines);
              }
              await sessions.save(rt.session);
            } catch {
              // best-effort
            }
          }
        })(),
        // a hung disk write must never make the app unquittable (PTY-23)
        deadline(2_000),
      ]).finally(() => {
        void Promise.race([registry?.killAllAndWait(2_000) ?? Promise.resolve(), deadline(2_500)]).finally(() => {
          remote?.stop();
          remote = null;
          // app.exit skips a second will-quit pass; everything durable has
          // been flushed or hit its deadline
          app.exit(0);
        });
      });
    });

    // window first, bridge second: the bridge (cert load, RSA keygen on
    // first run, HTTPS bind) is background infrastructure and must not sit
    // between whenReady and the first paint. The renderer's boot catch-up
    // (remoteGetState) covers the brief window before enableRemote lands.
    createWindow();

    // boot-time bridge start: persisted enable state (or FRAKTOLE_REMOTE_ENABLE)
    if ((await remoteStore.get()).enabled || process.env.FRAKTOLE_REMOTE_ENABLE === '1') {
      try {
        await enableRemote();
      } catch (err) {
        console.error('remote bridge start failed:', err);
        pushRemoteStatus();
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
