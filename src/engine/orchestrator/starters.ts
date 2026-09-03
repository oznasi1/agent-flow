import type { Flow, FlowEdge, FlowNode } from "./model";
import type { FlowTemplate } from "./templates";

/** Built-in templates are addressed by an id prefix rather than a flag on the
 * record, because the record shape is `FlowTemplate` — the same one a user's own
 * template has, read from disk by `readTemplates` and written by `writeTemplate`.
 * A prefix needs no schema change, survives the JSON round trip a template makes
 * when it is duplicated into a user template, and is checkable by the host
 * without holding the starter list.
 *
 * It is inside the `/^[A-Za-z0-9_-]+$/` charset both `VALID_FLOW_ID` and
 * `VALID_TEMPLATE_ID` enforce, so a built-in id is a legal filename — which is
 * exactly why `readTemplates` must SKIP files carrying it (Task 4): the id being
 * writable is what makes a shadowing file possible. */
export const BUILTIN_PREFIX = "builtin-";

export function isBuiltinTemplateId(id: string): boolean {
  return id.startsWith(BUILTIN_PREFIX);
}

/** `repos` and `mode` are empty ON PURPOSE, and `instantiate` fills them from the
 * card being attached (see its own `InstantiateCtx`). A starter cannot know a
 * user's checkout names or their configured prompt-mode ids — both are
 * `agentFlow.*` settings — and baking either in would break the
 * no-hardcoded-organization-values invariant for every install at once.
 *
 * `dest` IS baked: "worktree" is a concept this extension owns, not a value read
 * from anyone's configuration. */
const planned = (id: string, x: number, y: number): FlowNode => ({
  id, x, y, join: "any", kind: "planned", ticketKey: "", repos: [], mode: "", dest: "worktree",
});

/** `run` (free text), never `commandId`. A `CommandNode` carries one or the
 * other and the model refuses a node with neither; `commandId` names an entry in
 * `agentFlow.commands`, which is empty for most users since no built-ins ship, so
 * a starter naming one would render as a broken step on a fresh install.
 *
 * `cwdRepo` is left absent deliberately — the model's own comment says absent
 * means "the repo of the place the incoming edge came from", which is exactly
 * what a starter wants and the only answer it could give without knowing the
 * user's checkouts. */
const command = (id: string, x: number, y: number, run: string): FlowNode => ({
  id, x, y, join: "any", kind: "command", run,
});

const gate = (id: string, x: number, y: number, question: string): FlowNode => ({
  id, x, y, join: "any", kind: "gate", question,
});

const notify = (id: string, x: number, y: number, message: string): FlowNode => ({
  id, x, y, join: "any", kind: "notify", message,
});

const edge = (id: string, from: string, to: string, cond: FlowEdge["cond"]): FlowEdge =>
  ({ id, from, to, cond });

// `id: ""` — the same blank every OTHER template's inner flow carries
// (`normalizedTemplateFlow`, templates.ts): nothing resolves a template's
// inner flow id, `instantiate` always mints a fresh one, so this is not a
// placeholder that needs filling in. A non-empty id here used to be inert
// only because nothing could reach it — `flow:duplicateTemplate` copies a
// starter's inner flow verbatim, so duplicating one would have made it the
// one user template on disk whose inner `flow.id` was not `""`, silently
// wrong the day anything (e.g. an "Open a saved template" affordance) starts
// trusting that field.
const flow = (name: string, nodes: FlowNode[], edges: FlowEdge[]): Flow =>
  ({ id: "", name, armed: false, createdAt: 0, nodes, edges });

const starter = (id: string, name: string, f: Flow): FlowTemplate =>
  ({ schema: 1, id: `${BUILTIN_PREFIX}${id}`, name, params: {}, savedAt: 0, flow: f });

/** Three shapes, chosen to be the three things a first-time user most plausibly
 * wants and to between them exercise every node kind a template can hold. They
 * are deliberately short: a starter is read before it is trusted, and a
 * fifteen-rule graph is not read. */
export const STARTERS: readonly FlowTemplate[] = [
  starter("ship-it", "Ship it", flow("Ship it",
    [planned("n1", 0, 0), command("n2", 200, 0, "npm test"), gate("n3", 400, 0, "Open a PR?")],
    [
      edge("e1", "n1", "n2", { kind: "agent-ended-turn" }),
      edge("e2", "n2", "n3", { kind: "command-succeeded" }),
    ])),
  // Named "Test & merge" at first — wrong, since this shape neither checks CI
  // nor merges anything; it runs the tests and tells you when they pass. The
  // shape it would need to actually merge (a `branch-ci-passed` condition,
  // parameterised by `{ repo, branch }`) is unknowable to a built-in for the
  // same reason a starter's `planned` node ships empty `repos`/`mode` — the
  // user's own settings don't exist yet when this file is loaded. The `id`
  // keeps its released spelling regardless (`Flow.fromTemplate` references it,
  // and the Templates tab's "on N cards" count depends on it); only the
  // display name changed to say what this actually does.
  starter("test-and-merge", "Test & notify", flow("Test & notify",
    [planned("n1", 0, 0), command("n2", 200, 0, "npm test"), notify("n3", 400, 0, "Green — ready to merge")],
    [
      edge("e1", "n1", "n2", { kind: "agent-ended-turn" }),
      edge("e2", "n2", "n3", { kind: "command-succeeded" }),
    ])),
  starter("review-only", "Review only", flow("Review only",
    [planned("n1", 0, 0), notify("n2", 200, 0, "Ready for review")],
    [edge("e1", "n1", "n2", { kind: "agent-ended-turn" })])),
];
