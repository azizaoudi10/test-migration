import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { FraktoleMessage, SessionFile } from '../src/shared/ipc.js';

export const ORCHESTRATOR_ID = 'orchestrator';

/** Message ids must be unique per session; a per-process counter keeps
 *  m-<ts>-<seq> distinct even when two messages land in the same ms. */
let seq = 0;
export function messageId(): string {
  seq += 1;
  return `m-${Date.now()}-${seq}`;
}

/** Ids and targets flow into filesystem paths (mailbox dirs, inbox file
 *  names): keep them flat so a crafted message can never escape the
 *  session's agents directory. */
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Dispatch validation. The orchestrator may message any agent; there is no
 *  agent → orchestrator path (inbound was stripped — agents never wrote the
 *  outbox, so the reviewer monitors via read_scrollback instead). */
export function routeMessage(msg: FraktoleMessage): 'ok' | 'forbidden' | 'malformed' {
  if (!msg || typeof msg !== 'object') return 'malformed';
  if (typeof msg.from !== 'string' || typeof msg.to !== 'string') return 'malformed';
  if (typeof msg.id !== 'string') return 'malformed';
  if (typeof msg.body !== 'string' || typeof msg.at !== 'number') return 'malformed';
  if (msg.kind !== 'task' && msg.kind !== 'result' && msg.kind !== 'note') return 'malformed';
  if (msg.from !== ORCHESTRATOR_ID) return 'forbidden';
  if (msg.to === msg.from) return 'forbidden';
  if (!SAFE_ID_RE.test(msg.id) || !SAFE_ID_RE.test(msg.from) || !SAFE_ID_RE.test(msg.to)) return 'malformed';
  return 'ok';
}

/** Control bytes that could inject terminal escape sequences into the echo
 *  line (CSI/OSC and friends) — the echo goes to a live terminal. */
// eslint-disable-next-line no-control-regex
const ESC_SCRUB_RE = /[\x00-\x1f\x7f]/g;

/** Visible text injected into the target's terminal so a human or TUI agent
 *  sees the message; the panel log and mailbox files are the canonical copy. */
export function echoText(from: string, to: string, kind: string, body: string): string {
  const safe = body.replace(ESC_SCRUB_RE, '');
  return `\r\n\x1b[36m[fraktole]\x1b[0m ${from} \x1b[2m\u2192\x1b[0m ${to} \x1b[2m(${kind})\x1b[0m: ${safe}\r\n`;
}

export interface MailboxRouterOpts {
  /** Root that holds session dirs (userData/sessions). */
  root: string;
  currentSession: () => SessionFile | null;
  /** Live tileId for an agent id; 'orchestrator' maps to the judge tile. */
  tileOfAgent: (agentId: string) => string | null;
  /** Whether a tile's PTY is still alive — a dispatch to a persisted-but-
   *  dead agent must fail loudly instead of reporting success (RV-10). */
  isTileLive?: (tileId: string) => boolean;
  write: (tileId: string, text: string) => void;
  emit: (msg: FraktoleMessage) => void;
  logger?: (line: string) => void;
}

function log(opts: MailboxRouterOpts, line: string): void {
  (opts.logger ?? console.log)(line);
}

/** Compaction thresholds (usage-log's pattern): messages.jsonl used to grow
 *  unboundedly while every ingest and dedup check parsed the whole file. */
const LOG_COMPACT_EVERY = 1_000;
const LOG_MAX_LINES = 5_000;
const LOG_KEEP_LINES = 4_000;

/**
 * Dispatch log: the orchestrator writes to an agent's inbox, echoes into the
 * agent's terminal, and appends the canonical messages.jsonl log inside the
 * session dir. There is no inbound path — agent results are observed via
 * read_scrollback, never via the mailbox.
 */
export class MailboxRouter {
  /** Serializes log appends: hydrate/append/compact on messages.jsonl must
   *  not interleave (lost updates, torn lines). */
  private appendQueue: Promise<void> = Promise.resolve();
  /** Message ids already in the canonical log, per session — the dedup
   *  index. Hydrated once from disk, then maintained in memory: dedup is
   *  O(1) instead of a full-file parse per message. */
  private readonly loggedIds = new Map<string, Set<string>>();
  /** Hydrated rows parallel to loggedIds: listMessages returns the cached
   *  array instead of re-parsing the whole JSONL per call (audit RV-I11). */
  private readonly loggedRows = new Map<string, FraktoleMessage[]>();
  private appendedSinceCompact = 0;

  constructor(private readonly opts: MailboxRouterOpts) {}

  start(_sessionId: string): void {
    // no-op: no watcher/scan remains (outbound-only dispatch log).
  }

  stop(): void {
    // no-op: nothing to tear down.
  }

  /** Validates + writes a message produced inside Fraktole (the composer). */
  async sendFromOrchestrator(msg: FraktoleMessage): Promise<boolean> {
    const session = this.opts.currentSession();
    if (!session) return false;
    if (routeMessage(msg) !== 'ok') return false;
    if (!session.tiles.some((t) => t.agentId === msg.to)) return false;
    // a tile that exited leaves the agent in session.tiles until the next
    // renderer save — dispatching to it would report success with no echo
    const tileId = this.opts.tileOfAgent(msg.to);
    if (tileId === null) return false;
    if (this.opts.isTileLive !== undefined && !this.opts.isTileLive(tileId)) return false;
    await this.deliver(msg, ORCHESTRATOR_ID);
    return true;
  }

  /** Routes a message to the target's inbox, appends the canonical log and
   *  echoes it into the target's terminal. Idempotent by message id. */
  async deliver(msg: FraktoleMessage, _sourceAgentId: string): Promise<void> {
    const session = this.opts.currentSession();
    if (!session) return;
    if (await this.alreadyLogged(session.id, msg.id)) return;
    msg.from = ORCHESTRATOR_ID;
    if (msg.at === 0) msg.at = Date.now();

    const agentsDir = join(this.opts.root, session.id, 'agents');
    // belt over routeMessage's flat-id check: never write outside agentsDir
    const targetDir = resolve(join(agentsDir, msg.to));
    if (!targetDir.startsWith(resolve(agentsDir) + sep)) {
      log(this.opts, `mailbox: refusing target outside the agents dir (${msg.to})`);
      return;
    }
    await mkdir(join(targetDir, 'inbox'), { recursive: true });
    // inbox first, canonical log second: the log's id is the dedup marker,
    // so marking it delivered must be the LAST durability step (a crash
    // between the two must re-deliver on retry, not silently drop the
    // message — audit RV-30)
    await writeFile(join(targetDir, 'inbox', `${msg.id}.json`), JSON.stringify(msg, null, 2), 'utf8');
    await this.appendLog(session.id, msg);

    const tileId = this.opts.tileOfAgent(msg.to);
    if (tileId) this.opts.write(tileId, echoText(msg.from, msg.to, msg.kind, msg.body));
    this.opts.emit(msg);
  }

  /** Exact id match against the in-memory index — a raw substring check
   *  would false-positive on ids like m-<ts>-1 vs m-<ts>-12. */
  private async alreadyLogged(sessionId: string, id: string): Promise<boolean> {
    const ids = await this.loggedIdSet(sessionId);
    return ids.has(id);
  }

  /** Hydrates the id index once per session. A legacy file without a
   *  trailing newline is normalized first so appends can never concatenate
   *  onto a torn last line. */
  private async loggedIdSet(sessionId: string): Promise<Set<string>> {
    let ids = this.loggedIds.get(sessionId);
    if (ids) return ids;
    ids = new Set();
    const rows: FraktoleMessage[] = [];
    const file = this.logFile(sessionId);
    try {
      let raw = await readFile(file, 'utf8');
      if (raw.length > 0) {
        if (!raw.endsWith('\n')) {
          raw = `${raw}\n`;
          const tmp = `${file}.hydrate.${Date.now()}.tmp`;
          await writeFile(tmp, raw, 'utf8');
          await rename(tmp, file);
        }
        for (const line of raw.split('\n')) {
          if (line.length === 0) continue;
          try {
            const parsed = JSON.parse(line) as Partial<FraktoleMessage>;
            if (typeof parsed.id === 'string') {
              ids.add(parsed.id);
              rows.push(parsed as FraktoleMessage);
            }
          } catch {
            // torn line — the file was written via append, ignore it
          }
        }
      }
    } catch {
      // no log yet — first message in this session
    }
    this.loggedIds.set(sessionId, ids);
    this.loggedRows.set(sessionId, rows);
    return ids;
  }

  private logFile(sessionId: string): string {
    return join(this.opts.root, sessionId, 'messages.jsonl');
  }

  /** Append-only log: `appendFile` (O(new line), no full-file rewrite).
   *  Appends are queued so concurrent deliveries cannot interleave, and the
   *  id index grows with each append. Compaction keeps the file bounded. */
  private appendLog(sessionId: string, msg: FraktoleMessage): Promise<void> {
    const run = this.appendQueue.then(() => this.doAppendLog(sessionId, msg));
    this.appendQueue = run.catch(() => undefined);
    return run;
  }

  private async doAppendLog(sessionId: string, msg: FraktoleMessage): Promise<void> {
    const file = this.logFile(sessionId);
    const ids = await this.loggedIdSet(sessionId);
    await appendFile(file, `${JSON.stringify(msg)}\n`, 'utf8');
    ids.add(msg.id);
    this.loggedRows.get(sessionId)?.push(msg);
    this.appendedSinceCompact += 1;
    if (this.appendedSinceCompact >= LOG_COMPACT_EVERY) {
      this.appendedSinceCompact = 0;
      await this.compactLog(sessionId, ids);
    }
  }

  /** Rewrites the log keeping the most recent tail so the file (and every
   *  legacy full-file reader like listMessages) stays bounded. Runs inside
   *  the append queue — no concurrent writer can interleave. */
  private async compactLog(sessionId: string, ids: Set<string>): Promise<void> {
    const file = this.logFile(sessionId);
    try {
      const raw = await readFile(file, 'utf8');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      if (lines.length <= LOG_MAX_LINES) return;
      const kept = lines.slice(-LOG_KEEP_LINES);
      const tmp = `${file}.compact.${Date.now()}.tmp`;
      await writeFile(tmp, `${kept.join('\n')}\n`, 'utf8');
      await rename(tmp, file);
      ids.clear();
      const rows: FraktoleMessage[] = [];
      for (const line of kept) {
        try {
          const parsed = JSON.parse(line) as Partial<FraktoleMessage>;
          if (typeof parsed.id === 'string') {
            ids.add(parsed.id);
            rows.push(parsed as FraktoleMessage);
          }
        } catch {
          // ignore
        }
      }
      this.loggedRows.set(sessionId, rows);
      log(this.opts, `mailbox: compacted messages.jsonl (${lines.length} → ${kept.length} lines)`);
    } catch (err) {
      log(this.opts, `mailbox: log compaction failed: ${String(err)}`);
    }
  }

  async listMessages(sessionId: string): Promise<FraktoleMessage[]> {
    // hydrate once, then serve the cached rows (append/compact keep them in
    // sync) instead of re-parsing the whole JSONL on every call
    await this.loggedIdSet(sessionId);
    const rows = this.loggedRows.get(sessionId) ?? [];
    // coerce legacy at:0/undefined timestamps so they sort as oldest,
    // never NaN (which would make the sort a no-op)
    return [...rows].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  }
}
