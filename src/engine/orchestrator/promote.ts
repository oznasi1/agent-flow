// A planned node has no run, so no condition on it can be evaluated. The moment a
// launch succeeds it must become a real place, or a chain dies at its second step:
// "ASM-1 merged -> launch ASM-12 -> ASM-12's CI passes -> launch ASM-15" would
// never reach the third link.
//
// Same id, position and join, so every downstream edge keeps pointing at it.
import { Flow, PlaceNode } from "./model";

export function promoteToPlace(flow: Flow, nodeId: string, runKey: string, repo: string): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((n) => {
      // Only a planned node is promoted. Re-promoting a place would rewrite the
      // repo it is bound to, silently changing what every condition on it means.
      if (n.id !== nodeId || n.kind !== "planned") return n;
      const promoted: PlaceNode = {
        id: n.id, kind: "place", x: n.x, y: n.y, join: n.join, runKey, repo,
      };
      return promoted;
    }),
  };
}
