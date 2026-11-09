import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SessionView, type ActiveInfo } from './components/SessionView.js';
import { Explorer } from './components/Explorer.js';
import { FileEditor } from './components/FileEditor.js';
import { useFileEditor } from './file-state.js';
import { NewTileDialog } from './components/NewTileDialog.js';
import { Palette, type PaletteCommand } from './components/Palette.js';
import { SearchPanel } from './components/SearchPanel.js';
import { SettingsView } from './components/settings/SettingsView.js';
import { SessionNameDialog } from './components/SessionNameDialog.js';
import { Divider } from './components/Divider.js';
import { StatusBar } from './components/StatusBar.js';
import { HelpDialog } from './components/HelpDialog.js';
import { useGitStatus } from './components/explorer/useGitStatus.js';
import { TopBar, type AppTab } from './components/TopBar.js';
import { TestTab } from './components/TestTab.js';
import { RemoteTab } from './components/RemoteTab.js';
import { ThemeProvider } from './theme-context.js';
import { applyTheme, DEFAULT_THEME, THEME_IDS, THEMES, type ThemeId } from './themes.js';
import { modalDepth } from './modal-guard.js';
import { bridge, type MenuSessionAction, type Project, type PromptEntry, type SessionSummary, type SettingsSection } from './ipc.js';
import { applyRemappedKeys, getShortcutById } from './shortcuts.js';
import { expandPromptVars } from './shared/prompt-vars.js';
import { insertPrompt } from './prompt-bus.js';
import type { SessionState } from './session-state.js';
import { listIds } from './window-tree.js';
import './styles/index.css';

function BootOverlay({ leaving }: { leaving: boolean }): React.JSX.Element {
  return (
    <div className={`boot-overlay${leaving ? ' boot-leave' : ''}`}>
      <div className="boot-wordmark">
        <span className="boot-wordmark-inner">
          FRAKTOLE<span className="boot-dot">.</span>
        </span>
      </div>
    </div>
  );
}

/** Shown via Help → Reviewer commands… — grouped for the command codex. */
const REVIEWER_COMMANDS = [
  {
    label: 'goals',
    items: [{ cmd: '/goal <text>', desc: 'arm the loop carrier goal (bare /goal clears it)' }],
  },
  {
    label: 'context',
    items: [
      { cmd: '/compact', desc: 'force a context compaction now' },
      { cmd: '/summarize', desc: 'ask the model for a session recap, then compact the context' },
    ],
  },
  {
    label: 'control',
    items: [{ cmd: '/kill <id>', desc: 'kill the running agent tile <id>' }],
  },
];

/** Responsive geometry: the reviewer collapses to a rail + overlay drawer
 *  when the body cannot host a usable workspace and a usable column side by
 *  side. All clamps are pixel-derived so the 960px minimum window cannot
 *  squeeze either pane into unusable or clipped territory. */
const MIN_WORKSPACE_PX = 360;
const MIN_SIDE_PX = 180;
const MAX_SIDE_PX = 320;
const MIN_REVIEWER_PX = 420;
const DRAWER_BELOW_PX = 1120;

export function App(): React.JSX.Element {
  // session + tab orchestration
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [opened, setOpened] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [tab, setTab] = useState<AppTab>('node');
  const sessionStates = useRef<Map<string, SessionState>>(new Map());
  const activeSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);
  const tabRef = useRef<AppTab>(tab);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);
  const [activeInfo, setActiveInfo] = useState<ActiveInfo>({
    tileCount: 0,
    focusedCwd: null,
    sessionName: null,
    state: 'running',
    projectPath: null,
  } satisfies ActiveInfo);

  const [notice, setNotice] = useState<string | null>(null);
  const editor = useFileEditor({ onNotice: setNotice });
  const git = useGitStatus(activeInfo.projectPath);
  const [info, setInfo] = useState<string>('');
  const [bootLeaving, setBootLeaving] = useState(false);
  const [bootGone, setBootGone] = useState(false);
  const [themeId, setThemeIdState] = useState<ThemeId>(DEFAULT_THEME);
  const [sidePct, setSidePct] = useState({ left: 10, right: 40 });
  /** Wide layout: reviewer lives in its right-hand column. Narrow layout:
   *  a 28px rail toggles a full-height overlay drawer over the workspace. */
  const [reviewerDrawerOpen, setReviewerDrawerOpen] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  /** Prompt library snapshot for palette commands (refreshed on change). */
  const [prompts, setPrompts] = useState<PromptEntry[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogDefault, setDialogDefault] = useState('');
  const [sessionDialog, setSessionDialog] = useState<{ mode: 'new' } | { mode: 'rename' | 'save-as'; value: string } | null>(null);
  /** Open command palette with its initial mode (Ctrl+P files, Ctrl+Shift+P commands). */
  const [palette, setPalette] = useState<{ mode: 'files' | 'commands' } | null>(null);
  /** The in-app Settings Center (null = closed; otherwise the active section). */
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null);
  /** Project-wide search panel (editor tab, Ctrl+Shift+F). */
  const [searchOpen, setSearchOpen] = useState(false);
  const [help, setHelp] = useState<typeof REVIEWER_COMMANDS | null>(null);
  /** URL pushed by the reviewer's open_test_page; forwarded to the TestTab. */
  const [pendingTestUrl, setPendingTestUrl] = useState<string | null>(null);
  const defaultCwd = useRef('');
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyWidth, setBodyWidth] = useState(0);

  // the right pane's percentage is of the whole body; its flex parent is the
  // main area (body minus the left pane and one divider) — convert so a 40%
  // right pane really is 40% of the body
  const divPct = bodyWidth > 0 ? (6 / bodyWidth) * 100 : 0.5;
  const rightOfMain = (sidePct.right / Math.max(1, 100 - sidePct.left - divPct)) * 100;
  // below the drawer threshold the reviewer column cannot meet its minimum
  // usable width, so it becomes a rail + overlay instead of a clipped column
  const reviewerDrawer = bodyWidth > 0 && bodyWidth < DRAWER_BELOW_PX;
  // mirror for the stable window key handler (drawer toggles without
  // re-subscribing every listener)
  const drawerUiRef = useRef({ mode: false, open: true });
  drawerUiRef.current = { mode: reviewerDrawer, open: reviewerDrawerOpen };

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const ro = new ResizeObserver(() => setBodyWidth(body.getBoundingClientRect().width));
    ro.observe(body);
    return () => ro.disconnect();
  }, []);

  const dragDivider = useCallback((which: 'left' | 'right', clientX: number) => {
    const body = bodyRef.current;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    if (rect.width <= 0) return;
    const width = rect.width;
    setSidePct((s) => {
      if (which === 'left') {
        // explorer: 180–320px, never more than a quarter of the body
        const min = (MIN_SIDE_PX / width) * 100;
        const max = Math.max(min, Math.min(25, (MAX_SIDE_PX / width) * 100));
        const px = ((clientX - rect.left) / width) * 100;
        return { ...s, left: Math.min(max, Math.max(min, px)) };
      }
      // reviewer: at least 420px, and never squeeze the workspace below 360px
      const min = (MIN_REVIEWER_PX / width) * 100;
      const leftPx = (s.left / 100) * width + 6;
      const max = Math.max(min, ((width - leftPx - MIN_WORKSPACE_PX) / width) * 100);
      const px = ((rect.right - clientX) / width) * 100;
      return { ...s, right: Math.min(max, Math.max(min, px)) };
    });
  }, []);

  const refreshProjects = useCallback(async (): Promise<void> => {
    try {
      setProjects(await bridge.listProjects());
    } catch (err) {
      console.error('listProjects failed:', err);
    }
  }, []);

  const refreshSessions = useCallback(async (): Promise<void> => {
    try {
      setSessions(await bridge.listSessions());
    } catch {
      // session list unavailable — the switcher stays empty
    }
  }, []);

  const activate = useCallback((sid: string): void => {
    setActiveSessionId(sid);
    setOpened((prev) => (prev.includes(sid) ? prev : [...prev, sid]));
  }, []);

  useEffect(() => {
    void refreshProjects();
    void bridge
      .getAppInfo()
      .then((i) => {
        defaultCwd.current = i.home;
        setDialogDefault(i.home);
        setInfo(`${i.version} · ${i.shell}`);
      })
      .catch((err) => setInfo(`unavailable: ${String(err)}`));
      void bridge
        .getSettings()
        .then((s) => {
          // a theme picked from the native menu while boot was fetching wins
          // (audit REN-25)
          if (themePickedRef.current) return;
          const id = s.theme as ThemeId;
          const valid = THEME_IDS.includes(id);
          setThemeIdState(valid ? id : DEFAULT_THEME);
          applyTheme(valid ? id : DEFAULT_THEME);
          // apply remapped shortcuts from persisted settings
          const remaps = (s.shortcuts as Record<string, string> | undefined) ?? {};
          applyRemappedKeys(remaps);
        })
        .catch(() => applyTheme(DEFAULT_THEME));
    // boot: resume the most recent session, or start one fresh
    void (async () => {
      const list = await bridge.listSessions().catch(() => [] as SessionSummary[]);
      if (list.length > 0) {
        activate(list[0]!.id);
      } else {
        const created = await bridge.newSession('Session 1').catch(() => null);
        if (created) activate(created.session.id);
      }
      await refreshSessions();
    })();
  }, [activate, refreshSessions, refreshProjects]);

  const setTheme = useCallback((id: ThemeId) => {
    themePickedRef.current = true;
    setThemeIdState(id);
    applyTheme(id);
    void bridge.setSettings({ theme: id }).catch(() => setNotice('theme could not be saved'));
  }, []);

  const openSettings = useCallback((section: SettingsSection = 'general'): void => {
    setSettingsOpen(section);
  }, []);
  const openShortcuts = useCallback((): void => openSettings('shortcuts'), [openSettings]);

  const projectsRef = useRef<Project[]>([]);
  /** True once the user picked a theme (menu/palette/settings) — the boot
   *  settings fetch must not revert it (audit REN-25). */
  const themePickedRef = useRef(false);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  // persisted per-project editor tabs re-open when the active project changes
  // (restoreTabs itself is a per-project no-op, so re-runs are harmless)
  useEffect(() => {
    if (activeInfo.projectPath) void editor.restoreTabs(activeInfo.projectPath);
  }, [activeInfo.projectPath]);

  const dialogOpenRef = useRef(false);
  useEffect(() => {
    dialogOpenRef.current = dialogOpen;
  }, [dialogOpen]);

  const openTileDialog = useCallback(() => {
    if (dialogOpenRef.current) return;
    // native-menu openers bypass the keydown guard: a dialog must never
    // stack on top of the Settings/Search surfaces (audit REN-11)
    if (modalDepth() > 0) return;
    const ws = sessionStates.current.get(activeSessionIdRef.current ?? '');
    const f = ws?.focusedIdRef.current ?? null;
    const fallback = f
      ? (ws?.tilesRef.current.get(f)?.cwd ?? defaultCwd.current)
      : (projectsRef.current[0]?.path ?? defaultCwd.current);
    setDialogDefault(fallback);
    setDialogOpen(true);
  }, []);

  const openProject = useCallback(
    async (path: string): Promise<void> => {
      try {
        const opened = await bridge.openProject(path);
        if (opened.session.id !== activeSessionIdRef.current) {
          activate(opened.session.id);
        }
        await refreshSessions();
      } catch {
        // project/session load failure — keep the current view
      }
    },
    [activate, refreshSessions],
  );

  const newSession = useCallback(
    async (name: string): Promise<void> => {
      try {
        const opened = await bridge.newSession(name);
        activate(opened.session.id);
        await refreshSessions();
      } catch (err) {
        // surface the failure instead of closing the dialog into a no-op
        setNotice(`failed to create session: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
    [activate, refreshSessions],
  );

  const stopSession = useCallback(
    async (sid: string): Promise<void> => {
      try {
        await bridge.stopSession(sid);
      } catch {
        setNotice('failed to stop the session');
      }
      await refreshSessions();
    },
    [refreshSessions],
  );

  const startSession = useCallback(
    async (sid: string): Promise<void> => {
      try {
        await bridge.startSession(sid);
      } catch (err) {
        setNotice(`failed to start the session: ${err instanceof Error ? err.message : String(err)}`);
        await refreshSessions();
        return;
      }
      // the view's PTYs were killed by the stop; force a rebuild so the tiles
      // come back even if their exit events have not landed yet (audit PTY-12)
      void sessionStates.current.get(sid)?.reactivate(true);
      await refreshSessions();
    },
    [refreshSessions],
  );

  const pickAndAddFolder = useCallback((): void => {
    // the native dialog lives in main: the renderer never supplies a root
    // path, so it cannot register arbitrary filesystem scopes (SEC-1)
    void bridge.addProject().then((p) => {
      if (p) void refreshProjects();
    }).catch(() => undefined);
  }, [refreshProjects]);

  const removeProject = useCallback((path: string): void => {
    void bridge.removeProject(path).then(() => refreshProjects()).catch(() => undefined);
  }, [refreshProjects]);

  const openInEditor = useCallback((path: string): void => {
    void editor.openFile(path);
    setTab('editor');
  }, [editor.openFile]);

  const consumePendingTestUrl = useCallback((): void => setPendingTestUrl(null), []);

  const deleteSession = useCallback(
    async (sid: string): Promise<void> => {
      try {
        await bridge.deleteSession(sid);
      } catch {
        setNotice('failed to delete the session');
        return;
      }
      setOpened((prev) => prev.filter((s) => s !== sid));
      if (sid === activeSessionIdRef.current) {
        const list = await bridge.listSessions().catch(() => [] as SessionSummary[]);
        if (list.length > 0) {
          activate(list[0]!.id);
        } else {
          const created = await bridge.newSession('Session 1').catch(() => null);
          if (created) activate(created.session.id);
        }
      }
      await refreshSessions();
    },
    [activate, refreshSessions],
  );

  const confirmSessionDialog = useCallback(
    (name: string): void => {
      if (!sessionDialog) return;
      const activeId = activeSessionIdRef.current;
      if (sessionDialog.mode === 'new') {
        void newSession(name);
      } else if (activeId) {
        const ws = sessionStates.current.get(activeId) ?? null;
        if (sessionDialog.mode === 'rename') {
          void ws?.renameSession(name);
        } else {
          void bridge.saveSessionAs(activeId, name).then(() => refreshSessions()).catch(() => undefined);
        }
      }
      setSessionDialog(null);
    },
    [sessionDialog, newSession, refreshSessions],
  );

  const registerState = useCallback((sid: string, state: SessionState): (() => void) => {
    sessionStates.current.set(sid, state);
    return () => {
      sessionStates.current.delete(sid);
    };
  }, []);

  const dragLeft = useCallback((x: number) => dragDivider('left', x), [dragDivider]);
  const dragRight = useCallback((x: number) => dragDivider('right', x), [dragDivider]);
  const toggleReviewerDrawer = useCallback(() => setReviewerDrawerOpen((v) => !v), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (dialogOpenRef.current) return;
      // any open modal (palette, settings, help, session dialogs, editor
      // pending rows, …) disables the workspace shortcuts
      if (modalDepth() > 0) return;
      // Escape closes the reviewer drawer — unless the user is typing inside
      // it (composer/questions), in which case the drawer keeps focus
      if (e.key === 'Escape' && drawerUiRef.current.mode && drawerUiRef.current.open) {
        const t = e.target;
        if (!(t instanceof HTMLElement) || t.closest('.reviewer-drawer') === null) {
          e.preventDefault();
          setReviewerDrawerOpen(false);
          return;
        }
      }
      const key = e.key.toLowerCase();
      // alt+1/2/3 switch base tabs (e.code: Option+digit on macOS produces
      // dead-key characters on e.key — audit REN-18)
      if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        if (e.code === 'Digit1') {
          e.preventDefault();
          setTab('editor');
          return;
        }
        if (e.code === 'Digit2') {
          e.preventDefault();
          setTab('node');
          return;
        }
        if (e.code === 'Digit3') {
          e.preventDefault();
          setTab('test');
          return;
        }
        if (e.code === 'Digit4') {
          e.preventDefault();
          setTab('remote');
          return;
        }
      }
      // command palette: Ctrl+P files, Ctrl+Shift+P commands — never while
      // typing in an input/textarea/editor
      if (e.ctrlKey && !e.altKey && !e.metaKey && (key === 'p' || key === ',')) {
        const target = e.target;
        if (target instanceof HTMLElement) {
          if (target.closest('input, textarea, select') !== null || target.isContentEditable) return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (key === ',') openSettings('general');
        else setPalette({ mode: e.shiftKey ? 'commands' : 'files' });
        return;
      }
      // project search lives on the editor tab (terminal has its own search)
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && key === 'f' && tabRef.current === 'editor') {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
        return;
      }
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
      // the node-tile shortcuts must not hijack typing: they only apply on
      // the node tab, and never while an input/textarea/editor has focus —
      // the terminal itself is exempt, its hidden textarea is the tile's
      // own input
      if (tabRef.current !== 'node') return;
      const target = e.target;
      if (target instanceof HTMLElement && target.closest('.terminal-host') === null) {
        if (target.closest('input, textarea, select') !== null || target.isContentEditable) return;
      }
      const ws = sessionStates.current.get(activeSessionIdRef.current ?? '');
      if (!ws) return;
      let handled = true;
      if (key === 't') {
        openTileDialog();
      } else if (key === 'o') {
        pickAndAddFolder();
      } else if (key === 'w') {
        if (ws.reviewerFocusedRef.current) {
          // the reviewer column is focused — nothing to close
        } else if (ws.focusedIdRef.current) {
          ws.closeTile(ws.focusedIdRef.current);
        }
      } else if (key === 'enter') {
        if (!ws.reviewerFocusedRef.current) {
          const f = ws.focusedIdRef.current;
          if (f) ws.toggleZoom(f);
        }
      } else if (key === 'r') {
        // Ctrl+Shift+R toggles the narrow-layout reviewer drawer
        if (drawerUiRef.current.mode) setReviewerDrawerOpen((v) => !v);
        else handled = false;
      } else if (key === 'arrowleft' || key === 'arrowup') {
        ws.moveFocus('prev');
      } else if (key === 'arrowright' || key === 'arrowdown') {
        ws.moveFocus('next');
      } else if (/^Digit0$/.test(e.code)) {
        ws.setReviewerFocused(true);
      } else if (e.code.startsWith('Digit') && e.ctrlKey && e.shiftKey) {
        const n = parseInt(e.code.slice(5));
        if (n >= 1 && n <= 9 && ws) {
          const ids = listIds(ws.treeRef.current);
          const target = ids[n - 1];
          if (target) { ws.setFocusedId(target); handled = true; }
        }
      } else if (/^Digit[1-9]$/.test(e.code)) {
        ws.setReviewerFocused(false);
        const ids = listIds(ws.treeRef.current);
        const target = ids[Number(e.code.slice(5)) - 1];
        if (target) ws.setFocusedId(target);
      } else {
        handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [openTileDialog, pickAndAddFolder]);

  const handleSessionAction = useCallback(
    (action: MenuSessionAction) => {
      const activeId = activeSessionIdRef.current;
      const activeName = activeId ? (sessionStates.current.get(activeId)?.sessionRef?.current?.name ?? null) : null;
      if (action.action === 'new') {
        setSessionDialog({ mode: 'new' });
      } else if (action.action === 'rename') {
        setSessionDialog({ mode: 'rename', value: activeName ?? 'Session' });
      } else if (action.action === 'save-as') {
        setSessionDialog({ mode: 'save-as', value: activeName ?? 'Session' });
      } else if (action.action === 'open' && action.id) {
        activate(action.id);
      } else if (action.action === 'delete' && action.id) {
        const target = sessions.find((s) => s.id === action.id);
        if (target && window.confirm(`Delete session "${target.name}"?`)) {
          void deleteSession(action.id);
        }
      } else if (action.action === 'stop' && action.id) {
        void stopSession(action.id);
      } else if (action.action === 'start' && action.id) {
        void startSession(action.id);
      } else if (action.action === 'export-bundle') {
        if (!activeId) {
          setNotice('no active session to export');
          return;
        }
        void bridge
          .exportSessionBundle(activeId)
          .then((res) => {
            if (res.ok) setNotice(`session exported to ${res.path ?? 'bundle'}`);
            else if (!res.canceled) setNotice(res.error);
          })
          .catch(() => setNotice('session export failed'));
      } else if (action.action === 'import-bundle') {
        void bridge
          .importSessionBundle()
          .then((res) => {
            if (res.ok && res.session) {
              activate(res.session.id);
              void refreshSessions();
              setNotice(`session "${res.session.name}" imported`);
            } else if (!res.ok && !res.canceled) {
              setNotice(res.error);
            }
          })
          .catch(() => setNotice('session import failed'));
      }
    },
    [sessions, deleteSession, stopSession, startSession, activate, refreshSessions],
  );

  const handleHelp = useCallback((topic: string) => {
    if (topic === 'reviewer-commands') setHelp(REVIEWER_COMMANDS);
  }, []);

  useEffect(() => {
    const unsubTile = bridge.onMenuNewTile(openTileDialog);
    const unsubTheme = bridge.onMenuTheme((id) => {
      if (THEME_IDS.includes(id as ThemeId)) setTheme(id as ThemeId);
    });
    const unsubSpawn = bridge.onReviewerSpawnRequest((ev) => {
      const ws = sessionStates.current.get(ev.sessionId) ?? null;
      if (!ws) {
        void bridge.reviewerSpawnResult(ev.sessionId, ev.requestId, { tileId: null, agentId: ev.agentId });
        return;
      }
      const tileId = ws.addTile(ev.cwd, ev.agentId, ev.command);
      if (tileId === null) setNotice('no room for another tile — close one first');
      void bridge.reviewerSpawnResult(ev.sessionId, ev.requestId, { tileId, agentId: ev.agentId });
    });

    const unsubSession = bridge.onMenuSession(handleSessionAction);

    // the reviewer's open_test_page: switch to the Test tab and load
    const unsubTest = bridge.onTestOpen((sessionId: string, ev: { url: string }) => {
      if (sessionId !== activeSessionIdRef.current) activate(sessionId);
      setTab('test');
      setPendingTestUrl(ev.url);
    });
    // the native Help menu forwards topics here
    const unsubHelp = bridge.onMenuHelp(handleHelp);
    // the native Settings menu jumps straight to a section
    const unsubSettings = bridge.onMenuSettings((action) => openSettings(action.section ?? 'general'));
    return () => {
      unsubTile();
      unsubTheme();
      unsubSpawn();
      unsubSession();
      unsubTest();
      unsubHelp();
      unsubSettings();
    };
  }, [openTileDialog, setTheme, sessions, activate, deleteSession, stopSession, startSession, openSettings]);

  /** Every palette command: tabs, settings sections, themes, session and
   *  reviewer actions. Labels mirror the shortcut registry where one exists. */
  // prompt library snapshot for the palette (refreshed on every change)
  useEffect(() => {
    const load = (): void => {
      void bridge.listPrompts().then(setPrompts).catch(() => undefined);
    };
    load();
    return bridge.onPromptsChanged(load);
  }, []);

  const paletteCommands: PaletteCommand[] = [    { id: 'tab.editor', label: 'File Editor tab', keys: getShortcutById('tab.editor')?.keys ?? 'Alt+1', section: 'tabs', run: () => setTab('editor') },
    { id: 'tab.node', label: 'Node tab', keys: getShortcutById('tab.node')?.keys ?? 'Alt+2', section: 'tabs', run: () => setTab('node') },
    { id: 'tab.test', label: 'Test tab', keys: getShortcutById('tab.test')?.keys ?? 'Alt+3', section: 'tabs', run: () => setTab('test') },
    { id: 'tab.remote', label: 'Remote tab', keys: getShortcutById('tab.remote')?.keys ?? 'Alt+4', section: 'tabs', run: () => setTab('remote') },
    { id: 'settings.open', label: 'Open settings', keys: getShortcutById('settings.open')?.keys ?? 'Ctrl+,', section: 'settings', run: () => openSettings('general') },
    { id: 'settings.model', label: 'Settings: model', section: 'settings', run: () => openSettings('model') },
    { id: 'settings.sampling', label: 'Settings: sampling & context', section: 'settings', run: () => openSettings('sampling') },
    { id: 'settings.agents', label: 'Settings: agents & launchers', section: 'settings', run: () => openSettings('agents') },
    { id: 'settings.compose', label: 'Settings: auto compose', section: 'settings', run: () => openSettings('compose') },
    { id: 'settings.prompts', label: 'Settings: prompt library', section: 'settings', run: () => openSettings('prompts') },
    { id: 'settings.editor', label: 'Settings: editor', section: 'settings', run: () => openSettings('editor') },
    { id: 'settings.shortcuts', label: 'Settings: shortcuts', section: 'settings', run: () => openSettings('shortcuts') },
    { id: 'settings.usage', label: 'Settings: usage', section: 'settings', run: () => openSettings('usage') },
    { id: 'settings.advanced', label: 'Settings: advanced', section: 'settings', run: () => openSettings('advanced') },
    ...THEMES.map((t): PaletteCommand => ({      id: `theme.${t.id}`,
      label: `Theme: ${t.name}`,
      section: 'themes',
      run: () => {
        if (THEME_IDS.includes(t.id as ThemeId)) setTheme(t.id as ThemeId);
      },
    })),
    { id: 'tile.new', label: 'New tile', keys: getShortcutById('tile.new')?.keys ?? 'Ctrl+Shift+T', section: 'session', run: openTileDialog },
    { id: 'project.add', label: 'Add project folder', keys: getShortcutById('project.add')?.keys ?? 'Ctrl+Shift+O', section: 'project', run: pickAndAddFolder },
    {
      id: 'tile.close',
      label: 'Close focused tile',
      keys: getShortcutById('tile.close')?.keys ?? 'Ctrl+Shift+W',
      section: 'session',
      run: () => {
        const ws = sessionStates.current.get(activeSessionIdRef.current ?? '');
        const f = ws?.focusedIdRef.current;
        if (f) ws?.closeTile(f);
      },
    },
    {
      id: 'tile.zoom',
      label: 'Zoom focused tile',
      keys: getShortcutById('tile.zoom')?.keys ?? 'Ctrl+Shift+Enter',
      section: 'session',
      run: () => {
        const ws = sessionStates.current.get(activeSessionIdRef.current ?? '');
        const f = ws?.focusedIdRef.current;
        if (f) ws?.toggleZoom(f);
      },
    },
    {
      id: 'tile.focusPrev',
      label: 'Focus previous tile',
      keys: getShortcutById('tile.focusPrev')?.keys ?? 'Ctrl+Shift+Left',
      section: 'session',
      run: () => sessionStates.current.get(activeSessionIdRef.current ?? '')?.moveFocus('prev'),
    },
    {
      id: 'tile.focusNext',
      label: 'Focus next tile',
      keys: getShortcutById('tile.focusNext')?.keys ?? 'Ctrl+Shift+Right',
      section: 'session',
      run: () => sessionStates.current.get(activeSessionIdRef.current ?? '')?.moveFocus('next'),
    },
    {
      id: 'reviewer.focus',
      label: 'Focus the reviewer',
      keys: getShortcutById('reviewer.focus')?.keys ?? 'Ctrl+Shift+0',
      section: 'session',
      run: () => sessionStates.current.get(activeSessionIdRef.current ?? '')?.setReviewerFocused(true),
    },
    {
      id: 'tile.focusN',
      label: 'Focus tile 1-9',
      keys: getShortcutById('tile.focusN')?.keys ?? 'Ctrl+Shift+1..9',
      section: 'session',
      run: () => {},
    },
    {
      id: 'file.save',
      label: 'Save file',
      keys: getShortcutById('file.save')?.keys ?? 'Ctrl+S',
      section: 'editor',
      run: () => {
        if (editor.activePath) void editor.saveFile(editor.activePath);
      },
    },
    {
      id: 'search.project',
      label: 'Search in project',
      keys: getShortcutById('search.project')?.keys ?? 'Ctrl+Shift+F',
      section: 'editor',
      run: () => {
        if (activeInfo.projectPath) {
          setTab('editor');
          setSearchOpen(true);
        }
      },
    },
    // Prompt library: one palette entry per stored prompt (variables expand
    // against the focused tile/project before landing in the composer)
    ...prompts.map(
      (p): PaletteCommand => ({
        id: `prompt.${p.id}`,
        label: `Prompt: ${p.name}`,
        section: 'prompts',
        run: () => {
          void bridge.usePrompt(p.id).then((used) => {
            if (used === null) return;
            insertPrompt(
              expandPromptVars(used.body, {
                cwd: activeInfo.focusedCwd ?? '',
                project: activeInfo.projectPath ?? '',
                goal: '',
                selection: '',
              }),
            );
          });
        },
      }),
    ),
    {
      id: 'session.new',
      label: 'New session',
      section: 'session',
      run: () => setSessionDialog({ mode: 'new' }),
    },
    {
      id: 'session.rename',
      label: 'Rename session',
      section: 'session',
      run: () => setSessionDialog({ mode: 'rename', value: activeSessionId ? (sessionStates.current.get(activeSessionId)?.sessionRef?.current?.name ?? 'Session') : 'Session' }),
    },
    {
      id: 'session.save-as',
      label: 'Save session as…',
      section: 'session',
      run: () => setSessionDialog({ mode: 'save-as', value: activeSessionId ? (sessionStates.current.get(activeSessionId)?.sessionRef?.current?.name ?? 'Session') : 'Session' }),
    },
    {
      id: 'session.export',
      label: 'Export session bundle',
      section: 'session',
      run: () => {
        const activeId = activeSessionIdRef.current;
        if (!activeId) {
          setNotice('no active session to export');
          return;
        }
        void bridge
          .exportSessionBundle(activeId)
          .then((res) => {
            if (res.ok) setNotice(`session exported to ${res.path ?? 'bundle'}`);
            else if (!res.canceled) setNotice(res.error);
          })
          .catch(() => setNotice('session export failed'));
      },
    },
    {
      id: 'session.import',
      label: 'Import session bundle',
      section: 'session',
      run: () => {
        void bridge
          .importSessionBundle()
          .then((res) => {
            if (res.ok && res.session) {
              activate(res.session.id);
              void refreshSessions();
              setNotice(`session "${res.session.name}" imported`);
            } else if (!res.ok && !res.canceled) {
              setNotice(res.error);
            }
          })
          .catch(() => setNotice('session import failed'));
      },
    },
    {
      id: 'reviewer.compact',
      label: 'Reviewer: compact context now',
      section: 'reviewer',
      run: () => {
        const activeId = activeSessionIdRef.current;
        if (activeId) void bridge.compactReviewer(activeId);
      },
    },
    {
      id: 'reviewer.summarize',
      label: 'Reviewer: summarize session',
      section: 'reviewer',
      run: () => {
        const activeId = activeSessionIdRef.current;
        if (activeId) void bridge.summarizeReviewer(activeId).then(() => undefined);
      },
    },
  ];

  useEffect(() => {
    const t1 = window.setTimeout(() => setBootLeaving(true), 500);
    const t2 = window.setTimeout(() => setBootGone(true), 650);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  return (
    <ThemeProvider themeId={themeId} setTheme={setTheme}>
      <div className="app-shell">
        <TopBar
          tab={tab}
          onTabChange={setTab}
          sessionCount={opened.length}
          onNewTile={openTileDialog}
          onAddProject={pickAndAddFolder}
          onQuickOpen={() => setPalette({ mode: 'files' })}
          onCommandPalette={() => setPalette({ mode: 'commands' })}
          onQuit={() => {
            void bridge.quitApp().catch(() => window.close());
          }}
          onSessionAction={handleSessionAction}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onOpenSettings={openSettings}
          currentTheme={themeId}
          onThemeChange={(id) => {
            if (THEME_IDS.includes(id as ThemeId)) setTheme(id as ThemeId);
          }}
          onHelp={handleHelp}
          onOpenPrompts={() => openSettings('prompts')}
        />
        <div ref={bodyRef} className="app-body">
        <section className="pane pane-side" style={{ width: `${sidePct.left}%` }}>
          <Explorer
            projects={projects}
            activePath={activeInfo.focusedCwd}
            activeProjectPath={activeInfo.projectPath}
            gitStatus={git}
            onOpenProject={openProject}
            onOpenFile={openInEditor}
            onRemoveProject={removeProject}
            onAddFolder={pickAndAddFolder}
            onPathRenamed={editor.handlePathRenamed}
            onPathTrashed={editor.handlePathTrashed}
          />
        </section>
        <Divider onDrag={dragLeft} />
        <main className="app-main">
          {opened.map((sid) => (
            <SessionView
              key={sid}
              sessionId={sid}
              active={sid === activeSessionId}
              tab={tab}
              sideRightPct={rightOfMain}
              drawer={reviewerDrawer}
              drawerOpen={reviewerDrawerOpen}
              onToggleDrawer={toggleReviewerDrawer}
              onDragRight={dragRight}
              onActivate={activate}
              registerState={registerState}
              onActiveInfo={setActiveInfo}
              onOpenSettings={openSettings}
              onNotice={setNotice}
            />
          ))}
          <div className={`app-main-tab${tab === 'editor' ? '' : ' app-main-tab-hidden'}`}>
            <div className="editor-tab-stack">
              <div className="pane pane-workspace">
                <FileEditor
                  projectPath={activeInfo.projectPath}
                  files={editor.files}
                  activePath={editor.activePath}
                  reveal={editor.reveal}
                  onActivate={editor.activate}
                  onClose={editor.closeFile}
                  onUpdate={editor.updateContent}
                  onSave={editor.saveFile}
                  onSaveAll={() => void editor.saveAll()}
                  onReload={(p) => editor.reloadFile(p)}
                  onDismissStale={editor.dismissStale}
                />
              </div>
              {searchOpen && activeInfo.projectPath && (
                <SearchPanel
                  root={activeInfo.projectPath}
                  onClose={() => setSearchOpen(false)}
                  onOpen={(path, line) => {
                    // the overlay must not keep covering the file it opened
                    setSearchOpen(false);
                    void editor.openFile(path).then(() => editor.revealLine(path, line));
                  }}
                />
              )}
            </div>
          </div>
          <div className={`app-main-tab${tab === 'test' ? '' : ' app-main-tab-hidden'}`}>
            <div className="pane pane-workspace">
              <TestTab
                sessionId={activeSessionId ?? ''}
                pendingUrl={pendingTestUrl}
                onPendingUrlConsumed={consumePendingTestUrl}
                active={tab === 'test'}
              />
            </div>
          </div>
          <div className={`app-main-tab${tab === 'remote' ? '' : ' app-main-tab-hidden'}`}>
            <RemoteTab />
          </div>
        </main>
      </div>
      <StatusBar
        sessionName={activeInfo.sessionName}
        sessionState={activeInfo.state}
        tileCount={activeInfo.tileCount}
        focusedCwd={activeInfo.focusedCwd}
        info={info}
        branch={git?.branch ?? null}
        dirtyCount={editor.files.filter((f) => f.dirty).length}
        onOpenShortcuts={openShortcuts}
      />
      {dialogOpen && (
        <NewTileDialog
          projects={projects}
          defaultPath={dialogDefault}
          onConfirm={(path) => {
            setDialogOpen(false);
            const ws = sessionStates.current.get(activeSessionIdRef.current ?? '');
            const tileId = ws?.addTile(path);
            if (tileId === null) setNotice('no room for another tile — close one first');
          }}
          onCancel={() => setDialogOpen(false)}
        />
      )}
      {sessionDialog && (
        <SessionNameDialog
          title={sessionDialog.mode === 'new' ? 'new session' : sessionDialog.mode === 'rename' ? 'rename session' : 'save session as'}
          initial={sessionDialog.mode === 'new' ? '' : sessionDialog.value}
          confirmLabel={sessionDialog.mode === 'new' ? 'create' : sessionDialog.mode === 'rename' ? 'rename' : 'save'}
          onConfirm={confirmSessionDialog}
          onCancel={() => setSessionDialog(null)}
        />
      )}
      {palette && (
        <Palette
          root={activeInfo.projectPath}
          initialMode={palette.mode}
          commands={paletteCommands}
          onOpenFile={(path) => {
            setPalette(null);
            void editor.openFile(path);
            setTab('editor');
          }}
          onClose={() => setPalette(null)}
        />
      )}
      {settingsOpen && (
        <SettingsView
          section={settingsOpen}
          onSection={setSettingsOpen}
          onClose={() => setSettingsOpen(null)}
          onTheme={(id) => {
            if (THEME_IDS.includes(id as ThemeId)) setTheme(id as ThemeId);
          }}
          themeId={themeId}
          sessionId={activeSessionId}
          onNotice={setNotice}
          promptContext={{
            projectPath: activeInfo.projectPath,
            cwd: activeInfo.focusedCwd,
            goalText: null,
          }}
        />
      )}
      {notice && (
        <div className="app-notice" role="status" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
      {help && <HelpDialog sections={help} onClose={() => setHelp(null)} />}
      {!bootGone && <BootOverlay leaving={bootLeaving} />}
      </div>
    </ThemeProvider>
  );
}
