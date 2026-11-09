import type { SerNode } from './shared/ipc.js';
import type { TileId, TileNode } from './window-tree.js';

/** Live tree (ephemeral tile ids) → persisted tree (durable agent ids).
 *  Pure and renderer-safe: the renderer builds the save payload, main
 *  persists it. */
export function treeToSer(tree: TileNode | null, agentOf: (tileId: TileId) => string | null): SerNode | null {
  if (tree === null) return null;
  if (tree.kind === 'leaf') {
    const agentId = agentOf(tree.id);
    if (agentId === null) throw new Error(`tile ${tree.id} has no agent id yet`);
    return { k: 'leaf', agentId };
  }
  return {
    k: 'split',
    dir: tree.dir,
    ratio: tree.ratio,
    a: treeToSer(tree.a, agentOf)!,
    b: treeToSer(tree.b, agentOf)!,
  };
}

/** Persisted tree (agent ids) → live tree (fresh tile ids). Throws when the
 *  tree references an agent the session does not know — a loud failure beats
 *  spawning a ghost tile. Depth is bounded so a crafted bundle cannot blow
 *  the renderer's stack (audit PTY-19). */
export function treeFromSer(ser: SerNode | null, tileOf: (agentId: string) => TileId | null): TileNode | null {
  if (ser === null) return null;
  if (serDepth(ser) > MAX_TREE_DEPTH) throw new Error('session tree is too deep');
  return fromSer(ser, tileOf);
}

/** Maximum split depth for persisted trees. */
export const MAX_TREE_DEPTH = 64;

function serDepth(ser: SerNode): number {
  const stack: Array<{ node: SerNode; depth: number }> = [{ node: ser, depth: 1 }];
  let max = 1;
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > max) max = depth;
    if (node.k === 'split') {
      stack.push({ node: node.a, depth: depth + 1 }, { node: node.b, depth: depth + 1 });
    }
  }
  return max;
}

/**
 * Validates and clamps an untrusted serialized tree (session.json or an
 * imported bundle): unknown shapes are rejected, ratios are clamped to a
 * safe (0.01..0.99) range so NaN/Infinity can never poison tile geometry
 * (audit PTY-18), and depth is bounded. Returns null for null/undefined.
 */
export function sanitizeSerNode(ser: unknown, maxDepth: number = MAX_TREE_DEPTH): SerNode | null {
  if (ser === null || ser === undefined) return null;
  const out = sanitizeInner(ser, 1, maxDepth);
  return out;
}

function sanitizeInner(ser: unknown, depth: number, maxDepth: number): SerNode | null {
  if (typeof ser !== 'object' || ser === null || depth > maxDepth) return null;
  const node = ser as { k?: unknown; agentId?: unknown; dir?: unknown; ratio?: unknown; a?: unknown; b?: unknown };
  if (node.k === 'leaf') {
    return typeof node.agentId === 'string' && node.agentId.length > 0 ? { k: 'leaf', agentId: node.agentId } : null;
  }
  if (node.k === 'split') {
    if (node.dir !== 'h' && node.dir !== 'v') return null;
    const ratio = typeof node.ratio === 'number' && Number.isFinite(node.ratio) ? Math.min(0.99, Math.max(0.01, node.ratio)) : 0.5;
    const a = sanitizeInner(node.a, depth + 1, maxDepth);
    const b = sanitizeInner(node.b, depth + 1, maxDepth);
    if (a === null || b === null) return null;
    return { k: 'split', dir: node.dir, ratio, a, b };
  }
  return null;
}

/** Every agent id referenced by a serialized tree (iterative — safe on any
 *  depth). Used to validate a persisted/imported tree against the tile list. */
export function serNodeAgentIds(ser: SerNode): string[] {
  const out: string[] = [];
  const stack: SerNode[] = [ser];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.k === 'leaf') out.push(node.agentId);
    else stack.push(node.a, node.b);
  }
  return out;
}

function fromSer(ser: SerNode, tileOf: (agentId: string) => TileId | null): TileNode {
  if (ser.k === 'leaf') {
    const id = tileOf(ser.agentId);
    if (id === null) throw new Error(`unknown agent in tree: ${ser.agentId}`);
    return { kind: 'leaf', id };
  }
  return {
    kind: 'split',
    dir: ser.dir,
    ratio: ser.ratio,
    a: fromSer(ser.a, tileOf),
    b: fromSer(ser.b, tileOf),
  };
}
