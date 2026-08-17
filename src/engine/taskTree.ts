// A leaf module: no `vscode`, no `fs`, no git, no connector client — the same rule
// engine/brief.ts states in its own header, and for the same reason: any host-side
// caller must be able to depend on this, including ones that must stay free of the
// editor API.

/** One child as a source reports it. Structurally typed rather than imported from a
 *  connector, for the reason `engine/orchestrator/launch.ts` gives about
 *  `LaunchTicketDetail`: the engine must not depend on one connector's client, and
 *  `Capabilities.children.of()` returns a superset that satisfies this as-is. */
export interface ChildLike {
  key: string;
  summary: string;
  statusCategory?: string | null;
}

/** A leaf of the tree: a node with no children of its own, or one sitting on the
 *  depth boundary. `depth` is 1 for a direct child of the root. */
export interface TreeLeaf extends ChildLike {
  depth: number;
  parentKey: string;
}

export interface TreeResult {
  leaves: TreeLeaf[];
  /** Every omission the walk made: a subtree left unexplored (fetch failed or depth
   *  ran out), a key seen twice, a leaf the cap cut. The caller logs and reports
   *  this — nothing is ever dropped silently. */
  dropped: string[];
}

/** Three levels covers epic → story → subtask, which is the deepest shape worth
 *  fanning out. */
export const MAX_TREE_DEPTH = 3;
/** Twenty worktrees is already a lot of git and a lot of sessions; past this the
 *  caller reports the overflow instead of creating it. */
export const MAX_TREE_LEAVES = 20;

export interface TreeLimits {
  maxDepth?: number;
  maxLeaves?: number;
}

/**
 * Walk the tree under `rootKey` breadth-first and return its leaves.
 *
 * Breadth-first rather than depth-first so that when `maxLeaves` truncates, what
 * survives is the shallow, coarse work rather than a single deep branch's tail.
 *
 * The root is never a leaf: a ticket with no children yields `{ leaves: [], dropped:
 * [] }`, which is the caller's signal to behave exactly as it did before this module
 * existed.
 */
export async function buildTree(
  rootKey: string,
  fetch: (key: string) => Promise<ChildLike[]>,
  limits: TreeLimits = {},
): Promise<TreeResult> {
  const maxDepth = limits.maxDepth ?? MAX_TREE_DEPTH;
  const maxLeaves = limits.maxLeaves ?? MAX_TREE_LEAVES;
  const seen = new Set<string>([rootKey]);
  const seenDepth = new Map<string, number>([[rootKey, 0]]);
  const dropped: string[] = [];
  const leaves: TreeLeaf[] = [];
  let frontier: TreeLeaf[] = [{ key: rootKey, summary: "", depth: 0, parentKey: "" }];

  while (frontier.length) {
    const next: TreeLeaf[] = [];
    for (const node of frontier) {
      // On the boundary: this node is as deep as we go, so it IS the work.
      if (node.depth >= maxDepth) {
        leaves.push(node);
        continue;
      }
      let kids: ChildLike[];
      try {
        kids = await fetch(node.key);
      } catch {
        // One unreadable node must not cost us the rest of the tree. It becomes a
        // leaf (the work is still real) and is reported so the caller can say its
        // subtree went unexplored. The root is exempt: it is the ticket being taken,
        // not a child of it.
        if (node.depth > 0) leaves.push(node);
        dropped.push(node.key);
        continue;
      }
      const fresh: ChildLike[] = [];
      let hasCycleChild = false;
      for (const k of kids) {
        // Already seen: a cycle, or a diamond where two parents claim one child.
        // Either way it is walked once and the repeat is reported.
        if (seen.has(k.key)) {
          dropped.push(k.key);
          const childDepth = seenDepth.get(k.key) ?? -1;
          if (childDepth < node.depth + 1) {
            hasCycleChild = true;
          }
        } else fresh.push(k);
      }
      if (!fresh.length) {
        // Only mark as leaf if truly childless, or if we hit a cycle
        if (node.depth > 0 && (kids.length === 0 || hasCycleChild)) leaves.push(node);
        continue;
      }
      for (const k of fresh) {
        seen.add(k.key);
        seenDepth.set(k.key, node.depth + 1);
        next.push({ ...k, depth: node.depth + 1, parentKey: node.key });
      }
    }
    frontier = next;
  }

  if (leaves.length > maxLeaves) {
    for (const cut of leaves.slice(maxLeaves)) dropped.push(cut.key);
    leaves.length = maxLeaves;
  }
  return { leaves, dropped };
}
