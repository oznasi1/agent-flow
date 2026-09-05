import { describe, it, expect } from "vitest";
import { parseArgs, reportLines, tickEvent, USAGE } from "../../../src/headless/main";
import { FlowReport } from "../../../src/headless/pass";

describe("parseArgs", () => {
  it("reads the three flags and the settings path", () => {
    expect(parseArgs([])).toEqual({ dryRun: false, fetch: true, help: false });
    expect(parseArgs(["--dry-run", "--no-fetch", "--settings", "/s.json"])).toEqual({ dryRun: true, fetch: false, help: false, settings: "/s.json" });
    expect(parseArgs(["-h"])).toMatchObject({ help: true });
  });

  it("refuses an unknown argument and a bare --settings", () => {
    expect(parseArgs(["--loop"])).toEqual({ error: "unknown argument --loop" });
    expect(parseArgs(["--settings"])).toEqual({ error: "--settings needs a path" });
  });
});

describe("reportLines", () => {
  it("says when the lock was busy, when nothing was armed, and one line per thing a flow did or refused", () => {
    expect(reportLines({ lock: "busy", flows: [] }, false)).toEqual(["another Deck or tick holds the flows lock — nothing done this pass"]);
    expect(reportLines({ lock: "held", flows: [] }, false)).toEqual(["no armed flows"]);
    const lines = reportLines({ lock: "held", flows: [{
      id: "f1", name: "Ship it", fired: ["e2: ran deploy in aws-ops"], notified: ["Ship it: landed"], errored: [],
      expired: ["e9"], needsEditor: ["e3 (n1 → n2, launch)"], needsConsent: [], disarmedAtCeiling: undefined,
    }] }, false);
    expect(lines).toEqual([
      "Ship it (f1)",
      "  notify: Ship it: landed",
      "  fired: e2: ran deploy in aws-ops",
      "  expired: e9",
      "  needs an editor, left pending: e3 (n1 → n2, launch)",
    ]);
    expect(reportLines({ lock: "held", flows: [{ id: "f1", name: "n", fired: [], notified: [], errored: [], expired: [], needsEditor: [], needsConsent: [] }] }, false))
      .toEqual(["n (f1)", "  nothing to do"]);
  });

  it("usage names the three flags", () => {
    expect(USAGE).toContain("--settings");
    expect(USAGE).toContain("--dry-run");
    expect(USAGE).toContain("--no-fetch");
  });
});

describe("tickEvent", () => {
  const flow = (over: Partial<FlowReport> = {}): FlowReport => ({
    id: "f1", name: "Ship it", fired: [], notified: [], errored: [], expired: [],
    needsEditor: [], needsConsent: [], ...over,
  });

  it("sums every count across the pass's flows", () => {
    const ev = tickEvent({ lock: "held", flows: [
      flow({ fired: ["a", "b"], notified: ["n"], needsEditor: ["e3"] }),
      flow({ id: "f2", errored: ["x"], expired: ["y"], needsConsent: ["c"], disarmedAtCeiling: "spent 10 of 10" }),
    ] }, 5, false, 812);
    expect(ev).toEqual({
      name: "headless_tick", dry_run: false,
      // Five flows on disk, two of them armed: the gap is how many workflows this
      // user keeps around but leaves switched off.
      flow_count: 5, armed_count: 2,
      fired: 2, notified: 1, errored: 1, expired: 1,
      needs_editor: 1, needs_consent: 1, disarmed_at_ceiling: 1,
      duration_ms: 812,
    });
  });

  it("reports a pass that did nothing, rather than reporting nothing", () => {
    // A tick whose every pass is empty is exactly the signal that a user's cron
    // schedule is not doing what they hoped, so it must still be sent.
    expect(tickEvent({ lock: "held", flows: [] }, 0, true, 9)).toMatchObject({
      dry_run: true, flow_count: 0, armed_count: 0, fired: 0, needs_editor: 0, duration_ms: 9,
    });
  });

  it("carries no flow id, flow name, rule sentence or error text", () => {
    // Every string in a FlowReport is either a user's own workflow name or a
    // sentence built from node ids and error messages. None of it may leave the
    // machine, and the counts are what carry the analysis instead.
    const ev = tickEvent({ lock: "held", flows: [flow({
      name: "Ship the migration",
      fired: ["e2: ran deploy.sh --env=prod in aws-ops"],
      errored: ["e3 (n1 → n2, launch): worktree exists"],
      disarmedAtCeiling: "spent 10 of 10",
    })] }, 1, false, 1);
    const wire = JSON.stringify(ev);
    for (const secret of ["f1", "Ship the migration", "deploy.sh", "aws-ops", "worktree exists", "n1"]) {
      expect(wire).not.toContain(secret);
    }
  });

  it("counts a flow disarmed at its ceiling once, not once per line", () => {
    const ev = tickEvent({ lock: "held", flows: [
      flow({ disarmedAtCeiling: "spent 10 of 10", fired: ["a"] }),
      flow({ id: "f2" }),
    ] }, 2, false, 1);
    expect(ev).toMatchObject({ disarmed_at_ceiling: 1 });
  });
});
