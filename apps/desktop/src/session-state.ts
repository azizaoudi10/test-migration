import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge, type SessionStatus } from './ipc.js';
import { treeFromSer, treeToSer } from './session-tree.js';
import { captureAll } from './scrollback.js';
import type { OpenedSession, SessionSummary } from './ipc.js';
import type { SplitDir, TileId, TileNode } from './window-tree.js';
import { insert, bestSplitTarget, listIds, remove, swap } from './window-tree.js';
import { nextFocusTarget } from './focus-cycle.js';

/** Hard cap on tiles per session. With the pixel minimum enforced by
 *  bestSplitTarget this keeps the workspace legible; the reviewer spawn
 *  path surfaces the refusal. */
const MAX_TILES = 12;
/** Must match Workspace's GAP so the minimum-size math is exact. */
const TILE_GAP = 8;

export interface SessionTileMeta {
  id: TileId;
  cwd: string;
  /** Durable identity within the session; null until the PTY spawn returns. */
  agentId: string | null;
  /** Launcher command written into the shell after spawn (reviewer-spawned
   *  agent tiles; undefined = plain shell). */
  command?: string;
}

interface SessionStateRefs {
  treeRef: React.MutableRefObject<TileNode | null>;
  tilesRef: React.MutableRefObject<Map<TileId, SessionTileMeta>>;
  focusedIdRef: React.MutableRefObject<TileId | null>;
  zoomedIdRef: React.MutableRefObject<TileId | null>;
  reviewerFocusedRef: React.MutableRefObject<boolean>;
  sessionRef: React.MutableRefObject<SessionSummary | null>;
}

export interface SessionState extends SessionStateRefs {
  sessionId: string;
  session: SessionSummary | null;
  state: SessionStatus;
  tree: TileNode | null;
  tiles: Map<TileId, SessionTileMeta>;
  focusedId: TileId | null;
  zoomedId: TileId | null;
  /** True while the reviewer column (right pane) holds focus. */
  reviewerFocused: boolean;
  addTile(cwd: string, agentId?: string | null, command?: string): TileId | null;
  /** Workspace pixel size, reported by the mounted Workspace; used to keep
   *  every split above the minimum tile size. */
  setViewport(w: number, h: number): void;
  registerAgent(tileId: TileId, agentId: string): void;
  closeTile(id: TileId, external?: boolean): void;
  moveFocus(dir: 'prev' | 'next'): void;
  onSwap(a: TileId, b: TileId): void;
  setFocusedId(id: TileId): void;
  setReviewerFocused(v: boolean): void;
  toggleZoom(id: TileId): void;
  renameSession(name: string): Promise<void>;
  saveSession(opts?: { includeScrollback?: boolean }): Promise<void>;
  reactivate(force?: boolean): Promise<void>;
  agentOf(tileId: TileId): string | null;
  tileOf(agentId: string): TileId | null;
}

/**
 * One session's workspace state (tree, tiles, focus, zoom) plus its save
 * plumbing. One instance per open session, owned by a SessionView; hidden
 * views stay mounted so their PTYs keep running (keep-alive).
 */
export function useSessionState(sessionId: string): SessionState {
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [state, setState] = useState<SessionStatus>('running');
  const [tree, setTree] = useState<TileNode | null>(null);
  const [focusedId, setFocusedId] = useState<TileId | null>(null);
  const [zoomedId, setZoomedId] = useState<TileId | null>(null);
  const [reviewerFocused, setReviewerFocusedState] = useState(false);
  const [tiles, setTiles] = useState<Map<TileId, SessionTileMeta>>(new Map());

  const nextId = useRef(1);
  const insertDir = useRef<SplitDir>('h');
  const sessionRef = useRef<SessionSummary | null>(null);
  const busyRef = useRef(false);
  const loadedRef = useRef(false);
  // the view emptied because its PTYs were killed externally (stop / crash):
  // saving the empty state would erase the persisted arrangement
  const externalEmptyRef = useRef(false);
  // last reported workspace pixel size (bestSplitTarget input)
  const viewportRef = useRef({ w: 0, h: 0 });

  const treeRef = useRef<TileNode | null>(null);
  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  const tilesRef = useRef<Map<TileId, SessionTileMeta>>(new Map());
  useEffect(() => {
    tilesRef.current = tiles;
  }, [tiles]);

  const focusedIdRef = useRef<TileId | null>(null);
  useEffect(() => {
    focusedIdRef.current = focusedId;
  }, [focusedId]);

  const zoomedIdRef = useRef<TileId | null>(null);
  useEffect(() => {
    zoomedIdRef.current = zoomedId;
  }, [zoomedId]);

  const reviewerFocusedRef = useRef(false);
  useEffect(() => {
    reviewerFocusedRef.current = reviewerFocused;
  }, [reviewerFocused]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const agentOf = useCallback(
    (tileId: TileId): string | null => tilesRef.current.get(tileId)?.agentId ?? null,
    [],
  );

  const tileOf = useCallback(
    (agentId: string): TileId | null =>
      [...tilesRef.current.entries()].find(([, m]) => m.agentId === agentId)?.[0] ?? null,
    [],
  );

  const registerAgent = useCallback((tileId: TileId, agentId: string): void => {
    setTiles((m) => {
      const meta = m.get(tileId);
      if (!meta || meta.agentId === agentId) return m;
      const copy = new Map(m);
      copy.set(tileId, { ...meta, agentId });
      return copy;
    });
  }, []);

  const saveSession = useCallback(
    async (opts?: { includeScrollback?: boolean }): Promise<void> => {
      const current = sessionRef.current;
      if (!current || busyRef.current) return;
      // never erase a persisted arrangement from an externally-emptied view
      if (tilesRef.current.size === 0 && externalEmptyRef.current) return;
      // a tile whose spawn hasn't resolved yet has no agent id; saving now
      // would either throw in treeToSer or persist a half-built tree
      for (const [, meta] of tilesRef.current) {
        if (meta.agentId === null) return;
      }
      try {
        const ser = treeToSer(treeRef.current, (id) => tilesRef.current.get(id)?.agentId ?? null);
        const focusId = focusedIdRef.current;
        const zoomId = zoomedIdRef.current;
        // launcher commands per agent: restoring without them resurrects
        // agent tiles as bare shells (audit REN-09)
        const commands: Record<string, string> = {};
        for (const meta of tilesRef.current.values()) {
          if (meta.agentId !== null && typeof meta.command === 'string' && meta.command.length > 0) {
            commands[meta.agentId] = meta.command;
          }
        }
        await bridge.saveSession(sessionId, {
          tree: ser,
          agents: [...tilesRef.current.values()].map((m) => m.agentId as string),
          zoomedAgentId: zoomId ? (tilesRef.current.get(zoomId)?.agentId ?? null) : null,
          focusedAgentId: focusId ? (tilesRef.current.get(focusId)?.agentId ?? null) : null,
          judgeCwd: focusId ? (tilesRef.current.get(focusId)?.cwd ?? null) : null,
          commands,
          // the renderer's full-buffer capture rides only on the unload save:
          // the live recorder (1s debounce) is fresher than any 30s/1.5s
          // snapshot, and shipping every tile's buffer over IPC on each
          // periodic save is the single largest recurring waste
          scrollback: opts?.includeScrollback === false ? undefined : captureAll(sessionId, (id) => tilesRef.current.get(id)?.agentId ?? null),
        });
      } catch {
        // a save must never take the workspace down
      }
    },
    [],
  );

  const rebuildFrom = useCallback((opened: OpenedSession): void => {
    nextId.current = 1;
    insertDir.current = 'h';
    externalEmptyRef.current = false;
    const idByAgent = new Map<string, TileId>();
    const metas = new Map<TileId, SessionTileMeta>();
    for (const agent of opened.agents) {
      const id = `tile-${nextId.current}`;
      nextId.current += 1;
      idByAgent.set(agent.agentId, id);
      metas.set(id, { id, cwd: agent.cwd, agentId: agent.agentId, command: agent.command });
    }
    // build everything before committing: treeFromSer throws on unknown
    // agents, and a half-rebuilt state would let auto-save erase the
    // persisted arrangement
    const tree = treeFromSer(opened.session.tree, (agentId) => idByAgent.get(agentId) ?? null);
    setTiles(metas);
    setTree(tree);
    const focus = opened.session.focusedAgentId ? (idByAgent.get(opened.session.focusedAgentId) ?? null) : null;
    const zoom = opened.session.zoomedAgentId ? (idByAgent.get(opened.session.zoomedAgentId) ?? null) : null;
    setFocusedId(focus);
    setZoomedId(zoom);
  }, []);

  /** Loads this session from main; also called on every (re)activation.
   *  `force` rebuilds even when local tiles still exist — the explicit
   *  stop→start path, where the killed PTYs' exit events may not have
   *  arrived yet and the view would otherwise stay blank (audit PTY-12). */
  const reactivate = useCallback(async (force = false): Promise<void> => {
    busyRef.current = true;
    try {
      let opened = await bridge.openSession(sessionId);
      const wasStopped = opened.state === 'stopped';
      if (wasStopped) {
        // the user switched it off; revive it and respawn its tiles
        await bridge.startSession(sessionId);
        opened = await bridge.openSession(sessionId);
      }
      setState(opened.state);
      setSession({
        id: opened.session.id,
        name: opened.session.name,
        updatedAt: opened.session.updatedAt,
        agentCount: opened.agents.length,
        projectPath: opened.session.projectPath,
      });
      // rebuild only when the view has nothing yet, the session was dead, or
      // the view lost its tiles while the session still has agents (e.g. the
      // user stopped it from another session and started it before switching)
      const viewEmpty = tilesRef.current.size === 0;
      if (force || !loadedRef.current || wasStopped || (viewEmpty && opened.agents.length > 0)) {
        externalEmptyRef.current = false;
        rebuildFrom(opened);
        loadedRef.current = true;
      }
    } catch (err) {
      // session load failure: leave the view empty; the switcher can retry
      console.error('session load failed:', err);
    } finally {
      busyRef.current = false;
    }
  }, [sessionId, rebuildFrom]);

  // initial load
  useEffect(() => {
    void reactivate();
  }, [reactivate]);

  const renameSession = useCallback(
    async (name: string): Promise<void> => {
      const current = sessionRef.current;
      if (!current) return;
      try {
        await bridge.saveSessionAs(current.id, name);
        const updated = (await bridge.listSessions()).find((s) => s.id === current.id);
        if (updated) setSession(updated);
      } catch {
        // rename failure is surfaced by the caller through the dialog
      }
    },
    [],
  );

  // debounced auto-save on any structural change (scrollback is owned by the
  // main-process recorder — the arrangement is all this save ships)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void saveSession({ includeScrollback: false });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [tree, focusedId, zoomedId, tiles, saveSession]);

  // on quit the renderer flushes a final save (with scrollback)
  useEffect(() => {
    const onUnload = (): void => {
      void saveSession();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [saveSession]);

  // periodic safety net for the session arrangement; scrollback is kept
  // fresh by the recorder's own 1s debounced writes, so re-capturing every
  // tile's buffer here would be pure IPC+disk churn
  useEffect(() => {
    const timer = window.setInterval(() => {
      void saveSession({ includeScrollback: false });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [saveSession]);

  const addTile = useCallback(
    (cwd: string, agentId: string | null = null, command?: string): TileId | null => {
      if (tilesRef.current.size >= MAX_TILES) return null;
      const id = `tile-${nextId.current}`;
      const dir = insertDir.current;
      const currentTree = treeRef.current;
      // pick a splittable leaf: the focused one when it can afford the split,
      // otherwise the largest splittable tile; null means no room at all
      let target: TileId | null = focusedIdRef.current;
      if (currentTree !== null) {
        const vp = viewportRef.current;
        if (vp.w > 0 && vp.h > 0) {
          target = bestSplitTarget(currentTree, focusedIdRef.current, dir, {
            x: 0,
            y: 0,
            w: vp.w,
            h: vp.h,
            gap: TILE_GAP,
          });
          if (target === null) return null;
        }
      }
      // apply synchronously to the mirrors so batched spawns each see the
      // previous insertion (React state alone lands one render later)
      const nextTree = insert(currentTree, target, id, dir);
      treeRef.current = nextTree;
      nextId.current += 1;
      insertDir.current = dir === 'h' ? 'v' : 'h';
      setTiles((m) => {
        const copy = new Map(m);
        copy.set(id, { id, cwd, agentId, command });
        tilesRef.current = copy;
        return copy;
      });
      setTree(nextTree);
      focusedIdRef.current = id;
      setFocusedId(id);
      // a split under zoom would focus a hidden tile — leave zoom (audit PTY-17)
      zoomedIdRef.current = null;
      setZoomedId(null);
      return id;
    },
    [],
  );

  const setViewport = useCallback((w: number, h: number): void => {
    viewportRef.current = { w, h };
  }, []);

  const closeTile = useCallback((id: TileId, external = false): void => {
    // remove against the latest scheduled tree (not the effect-synced ref):
    // batched tile:exit events must each see the previous removal
    setTree((t) => {
      if (t === null) return t;
      if (!listIds(t).includes(id)) return t;
      const next = remove(t, id);
      if (listIds(next).length === 0) {
        if (external) {
          // killed by stop/crash: saving the empty arrangement would erase
          // the persisted tiles the restart must rebuild from
          externalEmptyRef.current = true;
        } else {
          // the USER closed the last tile: the empty arrangement is real
          // and must persist (audit PTY-21)
          externalEmptyRef.current = false;
        }
      }
      return next;
    });
    if (zoomedIdRef.current === id) setZoomedId((z) => (z === id ? null : z));
    setTiles((m) => {
      if (!m.has(id)) return m;
      const copy = new Map(m);
      copy.delete(id);
      return copy;
    });
  }, []);

  // keep focus valid: when the focused tile disappears (close/exit), fall
  // back to the first remaining tile; computed from the latest tree so
  // batched closes cannot leave focus dangling
  useEffect(() => {
    const ids = listIds(tree);
    if (focusedId === null) return;
    if (ids.length === 0) setFocusedId(null);
    else if (!ids.includes(focusedId)) setFocusedId(ids[0] ?? null);
  }, [tree, focusedId]);

  const moveFocus = useCallback((dir: 'prev' | 'next'): void => {
    const target = nextFocusTarget(listIds(treeRef.current), focusedIdRef.current, reviewerFocusedRef.current, dir);
    if (target.kind === 'reviewer') {
      setReviewerFocusedState(true);
      return;
    }
    setReviewerFocusedState(false);
    setFocusedId(target.id);
  }, []);

  const setReviewerFocused = useCallback((v: boolean): void => {
    setReviewerFocusedState(v);
  }, []);

  const onSwap = useCallback((a: TileId, b: TileId): void => {
    setTree((t) => {
      if (t === null) return t;
      const ids = listIds(t);
      // a drag can outlive a tile: ignore drops referencing unknown ids
      if (!ids.includes(a) || !ids.includes(b)) return t;
      return swap(t, a, b);
    });
  }, []);

  const toggleZoom = useCallback((id: TileId): void => {
    setZoomedId((z) => (z === id ? null : id));
  }, []);

  return {
    sessionId,
    session,
    state,
    tree,
    tiles,
    focusedId,
    zoomedId,
    reviewerFocused,
    treeRef,
    tilesRef,
    focusedIdRef,
    zoomedIdRef,
    reviewerFocusedRef,
    sessionRef,
    addTile,
    setViewport,
    registerAgent,
    closeTile,
    moveFocus,
    onSwap,
    setFocusedId,
    setReviewerFocused,
    toggleZoom,
    renameSession,
    saveSession,
    reactivate,
    agentOf,
    tileOf,
  };
}
