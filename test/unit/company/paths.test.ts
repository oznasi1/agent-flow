import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { companyPaths, ensureCompanyDirs } from "../../../src/company/paths";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-company-paths-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("companyPaths", () => {
  it("puts company state under .claude/company", () => {
    const p = companyPaths(root);
    expect(p.root).toBe(path.join(root, ".claude", "company"));
    expect(p.repoRoot).toBe(root);
  });

  it("names every directory and file the board needs", () => {
    const p = companyPaths(root);
    expect(p.queue).toBe(path.join(p.root, "queue"));
    expect(p.archive).toBe(path.join(p.root, "archive"));
    expect(p.landed).toBe(path.join(p.root, "landed"));
    expect(p.cycles).toBe(path.join(p.root, "cycles"));
    expect(p.drafts).toBe(path.join(p.root, "drafts"));
    expect(p.decisions).toBe(path.join(p.root, "decisions.jsonl"));
    expect(p.paused).toBe(path.join(p.root, "PAUSED"));
    expect(p.charter).toBe(path.join(p.root, "CHARTER.md"));
    expect(p.backlog).toBe(path.join(p.root, "backlog.md"));
    expect(p.metrics).toBe(path.join(p.root, "metrics.md"));
  });
});

describe("ensureCompanyDirs", () => {
  it("creates every directory, and is safe to call twice", () => {
    const p = companyPaths(root);
    ensureCompanyDirs(p);
    ensureCompanyDirs(p);
    for (const d of [p.root, p.queue, p.archive, p.landed, p.cycles, p.drafts]) {
      expect(fs.statSync(d).isDirectory()).toBe(true);
    }
  });

  it("does not create the files it names", () => {
    const p = companyPaths(root);
    ensureCompanyDirs(p);
    expect(fs.existsSync(p.decisions)).toBe(false);
    expect(fs.existsSync(p.paused)).toBe(false);
  });
});
