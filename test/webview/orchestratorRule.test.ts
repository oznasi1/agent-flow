// The rule module's PURE half, tested directly. Everything here used to be
// reachable only through one of the two presentations, which meant a writer's
// edge cases (a re-pick that must not clobber a typed branch, a `""` that must
// DELETE a field rather than store one) were asserted, when at all, through a
// `fireEvent` that could only exercise the paths a control happens to produce.
// These are the paths a hand-edited flow file produces too.
import { describe, expect, it } from "vitest";
import { emptyFlow, type Flow } from "../../src/engine/orchestrator/model";
import type { RulePreview } from "../../src/engine/orchestrator/preview";
import type { RunStatus } from "../../src/types";
import {
  COND_LABEL,
  condOffered,
  CWD_REPO_DEFAULT,
  defaultCondFor,
  DEFAULT_IDLE_MINUTES,
  endLabel,
  observationOf,
  offeredConds,
  OFFERED_CONDS,
  repoOptions,
  seedCond,
  sourceRepoOfNode,
  verdictWhy,
  withCond,
  withCondParams,
  withNodeCwdRepo,
  withNodeJoin,
} from "../../src/webview/orchestratorRule";

const flow = (over: Partial<Flow> = {}): Flow => ({
  id: "f1", name: "f", armed: false, createdAt: 1_000, nodes: [], edges: [], ...over,
});

/** A place wired to a notify terminal — the shape almost every writer below
 * needs, and the one whose source node has a repo to lend. */
const wired = (): Flow =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
      { id: "n2", kind: "notify", x: 320, y: 0, join: "any", message: "done" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" } }],
  });

describe("the condition picker's offer", () => {
  it("offers every kind the model has", () => {
    // The whole point of the change: `OFFERED_CONDS` used to be
    // `Object.keys(COND_LABEL).filter(isBareCond)`, which silently withheld the
    // three kinds that carry a parameter. Asserted as a superset of the three
    // rather than as an exact list, so adding a fourteenth bare kind does not
    // fail a test that has nothing to say about it.
    expect(OFFERED_CONDS).toEqual(expect.arrayContaining([
      "agent-idle-over", "ticket-status-is", "branch-ci-passed",
    ]));
  });

  it("still splits the offer by what the source node can answer", () => {
    // The split is the one filter that did NOT go away, and it is the one that
    // matters for money: `command-succeeded` on a rule out of a place is inert.
    const f = wired();
    expect(offeredConds(f, "n1")).not.toContain("command-succeeded");
    expect(offeredConds(f, "n1")).toContain("branch-ci-passed");
  });

  it("counts a parameterised condition as offered, so no extra option is added", () => {
    // `condOffered` used to answer `false` for every parameterised kind, which
    // is what made the inspector render a second `<option>` naming the repo and
    // branch. With the fields on screen that option would be a duplicate.
    const f = wired();
    f.edges[0].cond = { kind: "branch-ci-passed", repo: "agent-flow", branch: "main" };
    expect(condOffered(f, f.edges[0])).toBe(true);
  });
});

describe("observationOf", () => {
  // Same minimal RunStatus shape OrchestratorDrawer.test.tsx's own `runStatus`
  // fixture uses for its "survives a command-succeeded rule wired off a PLACE"
  // case — a REAL, matched run, not an empty `runs: []`. An empty array would
  // make this test pass for the wrong reason: `!status` already returns `null`
  // on its own, before the guard this test exists to pin ever runs, so the
  // guard's removal would go uncaught.
  const runStatus = (key: string, repo: string): RunStatus => ({
    run: { key, summary: "s", url: `https://j/browse/${key}`, createdAt: 1, mode: "multiroot",
      repos: [{ name: repo, path: `/r/${repo}`, isGit: true }], briefPaths: [] },
    column: "progress", ticketStatus: "In Progress", ticketCategory: "indeterminate",
    repos: [{ name: repo, path: `/r/${repo}`, branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 }],
    agent: { state: "working", lastActivityMs: 1, slug: null },
    windowOpen: true, prs: {}, agents: [], shelf: "board",
  });

  it("refuses gate-approved and gate-rejected, the same way it already refuses command-succeeded", () => {
    // Neither kind has a place-shaped observation to make: a gate's verdict
    // lives on its own incoming edge (`gateAnswer`, model.ts), never in the
    // CondContext this function would otherwise build from `e.from`'s
    // RunStatus. `describeCond`'s matching arms throw; this guard is what
    // keeps them unreachable, the same way it already keeps
    // `command-succeeded`'s throw unreachable.
    const f = wired();
    const approved = { ...f.edges[0], cond: { kind: "gate-approved" as const } };
    const rejected = { ...f.edges[0], cond: { kind: "gate-rejected" as const } };
    const runs = [runStatus("PROJ-1", "agent-flow")];
    expect(observationOf(f, approved, runs)).toBeNull();
    expect(observationOf(f, rejected, runs)).toBeNull();
  });
});

describe("seedCond", () => {
  it("gives an idle rule a real span rather than a blank", () => {
    expect(seedCond("agent-idle-over")).toEqual({ kind: "agent-idle-over", minutes: DEFAULT_IDLE_MINUTES });
  });

  it("leaves a status blank, because no default could be right", () => {
    expect(seedCond("ticket-status-is")).toEqual({ kind: "ticket-status-is", status: "" });
  });

  it("takes the repo it is offered and still leaves the branch blank", () => {
    // Half a guess: the repo is knowable from where the rule was drawn, the
    // branch is not — "main" typed in as a seed would read as a configured
    // answer on a repo whose trunk is `master`.
    expect(seedCond("branch-ci-passed", "payments-api")).toEqual({
      kind: "branch-ci-passed", repo: "payments-api", branch: "",
    });
  });

  it("blanks the repo when none is offered", () => {
    expect(seedCond("branch-ci-passed")).toEqual({ kind: "branch-ci-passed", repo: "", branch: "" });
  });

  it("returns a bare kind unchanged", () => {
    expect(seedCond("pr-merged")).toEqual({ kind: "pr-merged" });
  });
});

describe("sourceRepoOfNode", () => {
  it("lends a place's own repo", () => {
    expect(sourceRepoOfNode(wired(), "n1")).toBe("agent-flow");
  });

  it("lends a planned node's repo only when it names exactly one", () => {
    // Picking the first of several would be a guess dressed as a fact — and the
    // one it picked would be right about as often as it was wrong.
    const one = flow({ nodes: [{ id: "p", kind: "planned", x: 0, y: 0, join: "any", ticketKey: "PROJ-9", repos: ["api"], mode: "m", dest: "worktree" }] });
    const two = flow({ nodes: [{ id: "p", kind: "planned", x: 0, y: 0, join: "any", ticketKey: "PROJ-9", repos: ["api", "web"], mode: "m", dest: "worktree" }] });
    expect(sourceRepoOfNode(one, "p")).toBe("api");
    expect(sourceRepoOfNode(two, "p")).toBeUndefined();
  });

  it("has nothing to lend from a notify or a missing node", () => {
    expect(sourceRepoOfNode(wired(), "n2")).toBeUndefined();
    expect(sourceRepoOfNode(wired(), "nope")).toBeUndefined();
  });
});

describe("withCond", () => {
  it("seeds a parameterised kind instead of refusing to write it", () => {
    // The old behaviour was to hand `flow` back unchanged for exactly these
    // kinds, which is why the picker could not offer them.
    const next = withCond(wired(), "e1", "branch-ci-passed");
    expect(next.edges[0].cond).toEqual({ kind: "branch-ci-passed", repo: "agent-flow", branch: "" });
  });

  it("does not clobber a rule that is already on the kind being picked", () => {
    // The regression this guards is specific and easy to reintroduce: without
    // it, re-selecting the `<option>` that is already selected — which a browser
    // does not fire, but a keyboard and a test both can — reseeds the condition
    // and wipes the branch the user just typed.
    const f = wired();
    f.edges[0].cond = { kind: "branch-ci-passed", repo: "agent-flow", branch: "release/9" };
    const next = withCond(f, "e1", "branch-ci-passed");
    expect(next).toBe(f);
  });

  it("returns the same flow for an edge that is not there", () => {
    const f = wired();
    expect(withCond(f, "nope", "ci-passed")).toBe(f);
  });
});

describe("withCondParams", () => {
  it("edits one parameter and leaves its siblings alone", () => {
    const f = wired();
    f.edges[0].cond = { kind: "branch-ci-passed", repo: "agent-flow", branch: "main" };
    const next = withCondParams(f, "e1", { branch: "release/9" });
    expect(next.edges[0].cond).toEqual({ kind: "branch-ci-passed", repo: "agent-flow", branch: "release/9" });
  });

  it("leaves every other edge untouched", () => {
    const f = wired();
    f.edges.push({ id: "e2", from: "n1", to: "n2", cond: { kind: "ticket-status-is", status: "In Review" } });
    const next = withCondParams(f, "e2", { status: "Blocked" });
    expect(next.edges[0].cond).toEqual({ kind: "pr-merged" });
    expect(next.edges[1].cond).toEqual({ kind: "ticket-status-is", status: "Blocked" });
  });

  it("returns the same flow for an edge that is not there", () => {
    const f = wired();
    expect(withCondParams(f, "nope", { branch: "x" })).toBe(f);
  });
});

describe("repoOptions", () => {
  it("dedupes across runs and sorts, so the list does not reshuffle", () => {
    // Board order is whatever the deck happens to be showing; a picker whose
    // options move between renders is one nobody can build muscle memory for.
    const runs = [
      { repos: [{ name: "web" }, { name: "api" }] },
      { repos: [{ name: "api" }, { name: "infra" }] },
    ];
    expect(repoOptions(runs)).toEqual(["api", "infra", "web"]);
  });

  it("drops a nameless repo rather than offering a blank option", () => {
    // A blank option would be indistinguishable from the "choose a repo…" line
    // the picker shows for an unset value.
    expect(repoOptions([{ repos: [{ name: "" }, { name: "api" }] }])).toEqual(["api"]);
  });

  it("is empty for a board with no cards", () => {
    expect(repoOptions([])).toEqual([]);
  });
});

describe("withNodeCwdRepo", () => {
  const cmdFlow = (): Flow =>
    flow({ nodes: [{ id: "c1", kind: "command", x: 0, y: 0, join: "any", commandId: "deploy" }] });

  it("names a checkout on a command node", () => {
    const next = withNodeCwdRepo(cmdFlow(), "c1", "payments-api");
    expect(next.nodes[0]).toMatchObject({ cwdRepo: "payments-api" });
  });

  it("DELETES the field for the empty value rather than storing one", () => {
    // Absent is a meaning in the model — "the repo of the place the incoming
    // edge came from". A stored `""` would send `resolveCommand` looking for a
    // checkout named the empty string, which is the one thing that default
    // exists to avoid. `in`, not `=== undefined`: a present-but-undefined key is
    // exactly the shape this is written to prevent.
    const f = withNodeCwdRepo(cmdFlow(), "c1", "payments-api");
    const next = withNodeCwdRepo(f, "c1", "");
    expect("cwdRepo" in next.nodes[0]).toBe(false);
  });

  it("ignores a node that is not a command", () => {
    const f = wired();
    expect(withNodeCwdRepo(f, "n1", "api").nodes[0]).toEqual(f.nodes[0]);
  });
});

describe("withNodeJoin", () => {
  it("writes the junction's mode on the node, whatever kind it is", () => {
    // Every node kind carries `join` — a place, planned work, a notify terminal
    // and a command node can each be somewhere two rules meet — so this writer
    // deliberately does not narrow by kind the way the others do.
    const f = wired();
    expect(withNodeJoin(f, "n2", "all").nodes[1]).toMatchObject({ join: "all" });
    expect(withNodeJoin(f, "n1", "all").nodes[0]).toMatchObject({ join: "all" });
  });

  it("leaves the other nodes alone", () => {
    const next = withNodeJoin(wired(), "n2", "all");
    expect(next.nodes[0].join).toBe("any");
  });
});

describe("CWD_REPO_DEFAULT", () => {
  it("says what the default DOES, not merely that it is one", () => {
    // "(default)" would say only that somebody else decided. The whole reason
    // this option exists is that absent `cwdRepo` has a meaning worth naming.
    expect(CWD_REPO_DEFAULT).toMatch(/rule came from/);
  });
});

describe("gate nodes in the pickers", () => {
  const gateFlow = (): Flow => ({ ...emptyFlow("f1", "f", 0),
    nodes: [{ id: "g", kind: "gate", x: 0, y: 0, join: "any", question: "deploy to prod?" },
            { id: "c", kind: "command", x: 0, y: 0, join: "any", run: "d.sh" },
            { id: "p", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "r" }],
    edges: [] });

  it("names a gate 'gate' rather than falling through to '?'", () => {
    expect(endLabel(gateFlow(), "g")).toBe("gate");
  });

  it("offers exactly the two gate conditions off a gate source", () => {
    expect(offeredConds(gateFlow(), "g")).toEqual(["gate-approved", "gate-rejected"]);
  });

  it("offers neither gate condition off a place, and still offers the place-shaped list", () => {
    const off = offeredConds(gateFlow(), "p");
    expect(off).not.toContain("gate-approved");
    expect(off).not.toContain("gate-rejected");
    // The two negative assertions above would also pass today, before the
    // gate arm exists, because the OLD two-way filter already drops anything
    // that is not `command-succeeded` into this same bucket. What actually
    // distinguishes "correctly split into three" from "collapsed back to
    // two" is that the place bucket is neither empty nor the full set: it
    // still carries every place-shaped kind and nothing else.
    expect(off).toContain("pr-merged");
    expect(off).toContain("ci-passed");
    expect(off).not.toContain("command-succeeded");
    expect(off).toHaveLength(Object.keys(COND_LABEL).length - 3);
  });

  it("still offers command-succeeded off a command, and no gate condition", () => {
    expect(offeredConds(gateFlow(), "c")).toEqual(["command-succeeded"]);
  });

  it("seeds a new wire out of a gate with gate-approved", () => {
    expect(defaultCondFor(gateFlow(), "g")).toEqual({ kind: "gate-approved" });
  });

  it("labels both gate conditions without a parameter ellipsis", () => {
    expect(COND_LABEL["gate-approved"]).toBe("you approved");
    expect(COND_LABEL["gate-rejected"]).toBe("you rejected");
  });

  it("says a gate is waiting on you rather than borrowing a session's wording", () => {
    expect(verdictWhy({ verdict: "blocked", reason: "awaiting-answer" } as RulePreview))
      .toBe("it is waiting on your answer");
  });

  it("still says the two things it always said", () => {
    expect(verdictWhy({ verdict: "blocked", reason: "gone" } as RulePreview))
      .toBe("its card is not on the board right now");
    expect(verdictWhy({ verdict: "blocked", reason: "agent-state-unknown" } as RulePreview))
      .toBe("its session activity cannot be read");
  });
});
