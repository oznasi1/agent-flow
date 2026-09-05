import { describe, it, expect } from "vitest";
import { parseArgs, reportLines, USAGE } from "../../../src/headless/main";

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
