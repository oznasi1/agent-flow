import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { companyPaths, ensureCompanyDirs } from "../../../src/company/paths";
import { route, BoardContext } from "../../../src/company/server";

let root: string;
let ctx: BoardContext;
const KEY = "s3cret";
const q = () => new URLSearchParams(`key=${KEY}`);

function writeLanded(id: string, sha: string): void {
  fs.writeFileSync(
    path.join(ctx.paths.landed, `${id}.json`),
    JSON.stringify({
      id,
      cycle: "2026-07-31T17:09",
      role: "company-architect",
      title: "Dedupe the review-queue mappers",
      sha,
      landed_at: "2026-07-31T17:41:02Z",
    }),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-company-actions-"));
  const paths = companyPaths(root);
  ensureCompanyDirs(paths);
  ctx = {
    paths,
    token: KEY,
    spawnCycle: vi.fn(async () => ({ ok: true, detail: "started" })),
    gitRevert: vi.fn(async () => ({ ok: true, detail: "reverted 1 commit" })),
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("POST /api/cycle", () => {
  it("runs a full cycle by default", async () => {
    const r = await route("POST", "/api/cycle", q(), "{}", ctx);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, detail: "started" });
    expect(ctx.spawnCycle).toHaveBeenCalledWith("full");
  });

  it("runs apply mode when asked", async () => {
    await route("POST", "/api/cycle", q(), JSON.stringify({ mode: "apply" }), ctx);
    expect(ctx.spawnCycle).toHaveBeenCalledWith("apply");
  });

  it("400s an unknown mode without spawning anything", async () => {
    const r = await route("POST", "/api/cycle", q(), JSON.stringify({ mode: "yolo" }), ctx);
    expect(r.status).toBe(400);
    expect(ctx.spawnCycle).not.toHaveBeenCalled();
  });

  it("refuses to start a cycle while paused", async () => {
    await route("POST", "/api/pause", q(), JSON.stringify({ paused: true }), ctx);
    const r = await route("POST", "/api/cycle", q(), "{}", ctx);
    expect(r.status).toBe(409);
    expect(ctx.spawnCycle).not.toHaveBeenCalled();
  });

  it("passes a runner failure through as a 200 with ok:false", async () => {
    ctx.spawnCycle = vi.fn(async () => ({ ok: false, detail: "the cycle script is not installed yet" }));
    const r = await route("POST", "/api/cycle", q(), "{}", ctx);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: false, detail: "the cycle script is not installed yet" });
  });

  it("405s a GET", async () => {
    expect((await route("GET", "/api/cycle", q(), null, ctx)).status).toBe(405);
  });
});

describe("POST /api/undo", () => {
  it("reverts the recorded sha and clears the landed record", async () => {
    writeLanded("dedupe", "a1b2c3d4e5");
    const r = await route("POST", "/api/undo", q(), JSON.stringify({ id: "dedupe" }), ctx);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, detail: "reverted 1 commit" });
    expect(ctx.gitRevert).toHaveBeenCalledWith("a1b2c3d4e5");
    expect(fs.existsSync(path.join(ctx.paths.landed, "dedupe.json"))).toBe(false);
  });

  it("404s an unknown record without reverting", async () => {
    const r = await route("POST", "/api/undo", q(), JSON.stringify({ id: "ghost" }), ctx);
    expect(r.status).toBe(404);
    expect(ctx.gitRevert).not.toHaveBeenCalled();
  });

  it("keeps the record when the revert fails, so it can be retried", async () => {
    writeLanded("dedupe", "a1b2c3d4e5");
    ctx.gitRevert = vi.fn(async () => ({ ok: false, detail: "conflict" }));
    const r = await route("POST", "/api/undo", q(), JSON.stringify({ id: "dedupe" }), ctx);
    expect(r.json).toEqual({ ok: false, detail: "conflict" });
    expect(fs.existsSync(path.join(ctx.paths.landed, "dedupe.json"))).toBe(true);
  });

  it("400s a missing id", async () => {
    const r = await route("POST", "/api/undo", q(), "{}", ctx);
    expect(r.status).toBe(400);
    expect(ctx.gitRevert).not.toHaveBeenCalled();
  });
});
