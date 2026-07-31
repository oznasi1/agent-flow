import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { companyPaths, ensureCompanyDirs, CompanyPaths } from "../../../src/company/paths";
import {
  recordVerdict,
  readDecisions,
  acknowledgeLanded,
  readQueue,
} from "../../../src/company/queue";

let root: string;
let p: CompanyPaths;
const FIXED = () => "2026-07-31T18:02:11Z";

function writeItem(id: string): void {
  fs.writeFileSync(
    path.join(p.queue, `${id}.json`),
    JSON.stringify({
      id,
      cycle: "2026-07-31T17:09",
      role: "company-growth",
      kind: "copy",
      title: "Landing page hero",
      why: "because",
      artifact: { type: "text", inline: "hello" },
      risk: "gated",
      on_approve: "do the thing",
    }),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-company-verdict-"));
  p = companyPaths(root);
  ensureCompanyDirs(p);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("recordVerdict", () => {
  it("appends a decision and archives the item", () => {
    writeItem("hero");
    expect(recordVerdict(p, "hero", "approve", "", FIXED)).toEqual({ ok: true });

    expect(fs.existsSync(path.join(p.queue, "hero.json"))).toBe(false);
    expect(fs.existsSync(path.join(p.archive, "hero.json"))).toBe(true);
    expect(readDecisions(p)).toEqual([
      { id: "hero", verdict: "approve", note: "", at: "2026-07-31T18:02:11Z" },
    ]);
    expect(readQueue(p).items).toHaveLength(0);
  });

  it("keeps every decision, appending rather than overwriting", () => {
    writeItem("one");
    writeItem("two");
    recordVerdict(p, "one", "approve", "", FIXED);
    recordVerdict(p, "two", "reject", "wrong angle", FIXED);
    expect(readDecisions(p).map((d) => d.id)).toEqual(["one", "two"]);
  });

  it("stores the note on a revise", () => {
    writeItem("hero");
    recordVerdict(p, "hero", "revise", "Lead with the worktree, not the Jira fetch", FIXED);
    expect(readDecisions(p)[0].note).toBe("Lead with the worktree, not the Jira fetch");
  });

  it("refuses a revise with no note, because it teaches the role nothing", () => {
    writeItem("hero");
    const r = recordVerdict(p, "hero", "revise", "   ", FIXED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("note");
    expect(fs.existsSync(path.join(p.queue, "hero.json"))).toBe(true);
  });

  it("refuses an unknown verdict", () => {
    writeItem("hero");
    const r = recordVerdict(p, "hero", "maybe", "", FIXED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("verdict");
  });

  it("refuses an id that could escape the queue directory", () => {
    const r = recordVerdict(p, "../../escape", "approve", "", FIXED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("id");
  });

  it("refuses an unknown item without writing a decision", () => {
    const r = recordVerdict(p, "ghost", "approve", "", FIXED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ghost");
    expect(readDecisions(p)).toEqual([]);
  });

  it("refuses to decide the same item twice", () => {
    writeItem("hero");
    recordVerdict(p, "hero", "approve", "", FIXED);
    const second = recordVerdict(p, "hero", "reject", "", FIXED);
    expect(second.ok).toBe(false);
    expect(readDecisions(p)).toHaveLength(1);
  });
});

describe("readDecisions", () => {
  it("is empty before anything is decided", () => {
    expect(readDecisions(p)).toEqual([]);
  });

  it("skips malformed lines rather than throwing", () => {
    fs.writeFileSync(
      p.decisions,
      '{"id":"a","verdict":"approve","note":"","at":"t"}\nnot json\n\n',
    );
    expect(readDecisions(p).map((d) => d.id)).toEqual(["a"]);
  });
});

describe("acknowledgeLanded", () => {
  it("removes the landed record", () => {
    fs.writeFileSync(
      path.join(p.landed, "dedupe.json"),
      JSON.stringify({
        id: "dedupe", cycle: "c", role: "r", title: "t",
        sha: "a1b2c3d", landed_at: "2026-07-31T10:00:00Z",
      }),
    );
    expect(acknowledgeLanded(p, "dedupe")).toEqual({ ok: true });
    expect(fs.existsSync(path.join(p.landed, "dedupe.json"))).toBe(false);
  });

  it("refuses an unknown record", () => {
    expect(acknowledgeLanded(p, "ghost").ok).toBe(false);
  });

  it("refuses a traversing id", () => {
    expect(acknowledgeLanded(p, "../../etc/passwd").ok).toBe(false);
  });
});
