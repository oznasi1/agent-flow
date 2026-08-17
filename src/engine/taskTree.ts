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
  // Zero (or negative) depth means "consider no children", and the root is never a
  // leaf under any input — so there is nothing to walk and nothing to report. Guarded
  // here rather than inside the loop because the boundary check below is `>=`, which
  // the synthetic root node would otherwise satisfy at depth 0.
  if (maxDepth < 1) return { leaves: [], dropped: [] };
  const seen = new Set<string>([rootKey]);
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
      for (const k of kids) {
        // Already seen: a repeat in the walk. It is walked once and the repeat is
        // reported. A node whose only children are already claimed elsewhere in the
        // walk is not a leaf: its work lives under whichever parent claimed them.
        if (seen.has(k.key)) dropped.push(k.key);
        else fresh.push(k);
      }
      if (!fresh.length) {
        // A leaf is a node with no children. A node whose only children were already
        // claimed elsewhere in the walk is NOT one: its work lives under whichever
        // parent claimed them. Jira's single-parent constraint makes diamonds
        // impossible, so this is the cheap, honest answer.
        if (node.depth > 0 && kids.length === 0) leaves.push(node);
        continue;
      }
      for (const k of fresh) {
        seen.add(k.key);
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
