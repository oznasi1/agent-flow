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

/** sha256 of "hello", the inline artifact every fixture item below carries. */
const HELLO_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

function writeItem(id: string, over: Record<string, unknown> = {}): void {
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
      ...over,
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
      {
        id: "hero",
        verdict: "approve",
        note: "",
        at: "2026-07-31T18:02:11Z",
        cycle: "2026-07-31T17:09",
        role: "company-growth",
        title: "Landing page hero",
        artifactSha256: HELLO_SHA256,
      },
    ]);
    expect(readQueue(p).items).toHaveLength(0);
  });

  it("describes the decision without needing the archived body", () => {
    // The line has to stand on its own: the archive is the only copy of the
    // content, and an id alone cannot say what was judged.
    writeItem("hero");
    recordVerdict(p, "hero", "reject", "wrong angle", FIXED);
    fs.rmSync(path.join(p.archive, "hero.json"));

    const [d] = readDecisions(p);
    expect(d.cycle).toBe("2026-07-31T17:09");
    expect(d.role).toBe("company-growth");
    expect(d.title).toBe("Landing page hero");
    expect(d.artifactSha256).toBe(HELLO_SHA256);
  });

  it("digests the artifact the reviewer was shown, not the item around it", () => {
    writeItem("hero", { artifact: { type: "text", inline: "a different draft" } });
    recordVerdict(p, "hero", "approve", "", FIXED);
    const digest = readDecisions(p)[0].artifactSha256;
    expect(digest).toBeDefined();
    expect(digest).not.toBe(HELLO_SHA256);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("still records the verdict when the artifact cannot be resolved, minus the digest", () => {
    // The reviewer saw the error in the pane and may well be rejecting it for
    // exactly that reason — refusing the verdict would trap the item.
    writeItem("hero", { artifact: { type: "text", path: ".claude/company/drafts/gone.md" } });
    expect(recordVerdict(p, "hero", "reject", "no artifact", FIXED)).toEqual({ ok: true });
    const [d] = readDecisions(p);
    expect(d.artifactSha256).toBeUndefined();
    expect(d.title).toBe("Landing page hero");
  });

  it("refuses to archive over an existing entry, writing nothing at all", () => {
    // A reused id: ID_RE does not make ids unique across cycles, and a rename
    // would replace the earlier body with no trace but two identical log lines.
    writeItem("hero");
    recordVerdict(p, "hero", "approve", "first pass", FIXED);
    const logBefore = fs.readFileSync(p.decisions, "utf8");
    const archivedBefore = fs.readFileSync(path.join(p.archive, "hero.json"), "utf8");

    writeItem("hero", { title: "A different proposal, same id", cycle: "2026-08-01T09:00" });
    const second = recordVerdict(p, "hero", "reject", "second pass", FIXED);

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("archive/hero.json");
    expect(fs.readFileSync(p.decisions, "utf8")).toBe(logBefore);
    expect(fs.readFileSync(path.join(p.archive, "hero.json"), "utf8")).toBe(archivedBefore);
    expect(readDecisions(p)).toHaveLength(1);
    // The pending item is left alone too, so the collision can be fixed by
    // renaming it rather than by recovering it from a rename that already ran.
    expect(fs.existsSync(path.join(p.queue, "hero.json"))).toBe(true);
  });

  it("refuses a pending item it cannot understand, rather than logging a blank decision", () => {
    fs.writeFileSync(path.join(p.queue, "broken.json"), "{ not json");
    const r = recordVerdict(p, "broken", "approve", "", FIXED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("broken");
    expect(readDecisions(p)).toEqual([]);
    expect(fs.existsSync(path.join(p.archive, "broken.json"))).toBe(false);
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

  it("still parses a line written before the record was widened", () => {
    // The log is append-only: lines carrying only the original four fields are
    // history and must keep reading, not be rejected for what they lack.
    fs.writeFileSync(
      p.decisions,
      '{"id":"legacy","verdict":"revise","note":"lead with the worktree","at":"2026-07-30T09:00:00Z"}\n' +
        '{"id":"fresh","verdict":"approve","note":"","at":"2026-07-31T18:02:11Z",' +
        '"cycle":"2026-07-31T17:09","role":"company-growth","title":"Landing page hero",' +
        `"artifactSha256":"${HELLO_SHA256}"}\n`,
    );
    const [legacy, fresh] = readDecisions(p);
    expect(legacy).toEqual({
      id: "legacy",
      verdict: "revise",
      note: "lead with the worktree",
      at: "2026-07-30T09:00:00Z",
    });
    expect(legacy.cycle).toBeUndefined();
    expect(legacy.artifactSha256).toBeUndefined();
    expect(fresh.artifactSha256).toBe(HELLO_SHA256);
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
