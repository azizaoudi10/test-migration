/** The desktop-side view of the world the remote bridge exposes, exactly as
 *  the wire protocol (docs/remote-protocol.md §4) describes it. main.ts
 *  implements this against the live session registry / mailbox router. */

export interface SessionRow {
  id: string;
  name: string;
  /** Bound project path ('' when the session has none). */
  project: string;
  alive: boolean;
  tileCount: number;
  updatedAt: number;
}

export interface TileRow {
  /** Durable agent id (the id used by task.send / tile.subscribe). */
  id: string;
  name: string;
  kind: 'agent' | 'shell' | 'reviewer';
  cwd: string;
  lines: number;
  lastActiveAgoSec: number;
}

export interface MessageRow {
  kind: 'task' | 'result' | 'note';
  from: string;
  to: string;
  body: string;
  ts: number;
}

/** Events the desktop pushes into the bridge (§5). `sessionId` scopes the
 *  fan-out internally; it is not part of the wire params for tile events. */
export type RemoteEvent =
  | { type: 'tile.output'; sessionId: string; tileId: string; data: string; ts: number }
  | { type: 'tile.state'; sessionId: string; tileId: string; alive: boolean; lines: number }
  | { type: 'session.state'; sessionId: string; alive: boolean }
  | { type: 'message.new'; sessionId: string; msg: MessageRow };

export interface RemoteBackend {
  serverName: string;
  version: string;
  listSessions(): Promise<SessionRow[]>;
  listTiles(sessionId: string): Promise<TileRow[]>;
  /** Raw scrollback bytes for a client-facing tile id ('' = none). */
  readScrollback(tileId: string, tail?: number, sessionId?: string): Promise<string>;
  /** Resolves a client-facing tile id to its live tile id (null = not live). */
  liveTileOf(sessionId: string, tileId: string): Promise<string | null>;
  /** Scrollback snapshot for a subscription (≤ 200 lines). */
  snapshot(tileId: string, sessionId?: string): Promise<string>;
  /** Delivers a task/note from the phone into the orchestrator mailbox.
   *  sessionId scopes the agent id — agent-N repeats in every session. */
  sendTask(args: { sessionId: string; agentId: string; kind: 'task' | 'note'; body: string }): Promise<{
    ok: boolean;
    messageId?: string;
    error?: string;
  }>;
  /** Last N messages of the session mailbox. */
  listMessages(limit?: number): Promise<MessageRow[]>;
  /** The global prompt library (read-only for the phone). */
  listPrompts(): Promise<Array<{ id: string; name: string; body: string; tags: string[]; useCount: number }>>;
  exportPrompts(): Promise<string>;
  importPrompts(json: string): Promise<{ imported: number; errors: string[] }>;
  /** Spawns an agent tile (kind: launcher command; 'shell' = plain shell).
   *  sessionId scopes the spawn to a phone-supplied session when present. */
  spawnAgent(args: { sessionId?: string; cwd?: string; kind?: string; name?: string }): Promise<{
    ok: boolean;
    agentId?: string;
    error?: string;
  }>;
}
