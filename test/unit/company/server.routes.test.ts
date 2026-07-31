import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { companyPaths, ensureCompanyDirs } from "../../../src/company/paths";
import { route, BoardContext } from "../../../src/company/server";
import { readDecisions, isPaused } from "../../../src/company/queue";

let root: string;
let ctx: BoardContext;
const KEY = "s3cret";

function q(key: string | null = KEY): URLSearchParams {
  return new URLSearchParams(key === null ? "" : `key=${key}`);
}

function writeItem(id: string, over: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(ctx.paths.queue, `${id}.json`),
    JSON.stringify({
      id,
      cycle: "2026-07-31T17:09",
      role: "company-growth",
      kind: "copy",
      title: `Item ${id}`,
      why: "because",
      artifact: { type: "text", inline: "a draft" },
      risk: "gated",
      on_approve: "do the thing",
      ...over,
    }),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-company-routes-"));
  const paths = companyPaths(root);
  ensureCompanyDirs(paths);
  ctx = {
    paths,
    token: KEY,
    spawnCycle: vi.fn(async () => ({ ok: true, detail: "started" })),
    gitRevert: vi.fn(async () => ({ ok: true, detail: "reverted" })),
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("token gate", () => {
  it("refuses every request without the key", async () => {
    for (const [method, url] of [
      ["GET", "/"],
      ["GET", "/api/queue"],
      ["POST", "/api/decision"],
    ] as const) {
      const r = await route(method, url, q(null), "{}", ctx);
      expect(r.status).toBe(401);
    }
  });

  it("refuses a wrong key", async () => {
    expect((await route("GET", "/api/queue", q("wrong"), null, ctx)).status).toBe(401);
  });
});

describe("GET /", () => {
  it("serves the board page", async () => {
    const r = await route("GET", "/", q(), null, ctx);
    expect(r.status).toBe(200);
    expect(r.html).toContain("<!doctype html>");
  });
});

describe("GET /api/queue", () => {
  it("returns pending items, landed records, pause state and last cycle", async () => {
    writeItem("hero");
    const r = await route("GET", "/api/queue", q(), null, ctx);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      pending: [{ id: "hero" }],
      landed: [],
      quarantined: [],
      paused: false,
      lastCycle: null,
    });
  });

  it("reports quarantined files", async () => {
    fs.writeFileSync(path.join(ctx.paths.queue, "broken.json"), "nope");
    const r = await route("GET", "/api/queue", q(), null, ctx);
    expect((r.json as { quarantined: unknown[] }).quarantined).toHaveLength(1);
  });
});

describe("GET /api/artifact", () => {
  it("returns the resolved artifact for a pending item", async () => {
    writeItem("hero");
    const r = await route("GET", "/api/artifact", new URLSearchParams(`key=${KEY}&id=hero`), null, ctx);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ type: "text", content: "a draft", truncated: false });
  });

  it("404s an unknown id", async () => {
    const r = await route("GET", "/api/artifact", new URLSearchParams(`key=${KEY}&id=ghost`), null, ctx);
    expect(r.status).toBe(404);
  });

  it("400s a missing id", async () => {
    const r = await route("GET", "/api/artifact", q(), null, ctx);
    expect(r.status).toBe(400);
  });

  it("400s an artifact that cannot be read", async () => {
    writeItem("bad", { artifact: { type: "text", path: "../../../etc/passwd" } });
    const r = await route("GET", "/api/artifact", new URLSearchParams(`key=${KEY}&id=bad`), null, ctx);
    expect(r.status).toBe(400);
  });
});

describe("POST /api/decision", () => {
  it("records the verdict", async () => {
    writeItem("hero");
    const r = await route(
      "POST",
      "/api/decision",
      q(),
      JSON.stringify({ id: "hero", verdict: "approve", note: "" }),
      ctx,
    );
    expect(r.status).toBe(200);
    expect(readDecisions(ctx.paths)[0].verdict).toBe("approve");
  });

  it("400s a revise with no note", async () => {
    writeItem("hero");
    const r = await route(
      "POST",
      "/api/decision",
      q(),
      JSON.stringify({ id: "hero", verdict: "revise", note: "" }),
      ctx,
    );
    expect(r.status).toBe(400);
    expect(readDecisions(ctx.paths)).toEqual([]);
  });

  it("400s malformed JSON", async () => {
    const r = await route("POST", "/api/decision", q(), "{ nope", ctx);
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: expect.stringContaining("json") });
  });

  it("400s a body that is not an object", async () => {
    const r = await route("POST", "/api/decision", q(), "[]", ctx);
    expect(r.status).toBe(400);
  });

  it("405s a GET", async () => {
    expect((await route("GET", "/api/decision", q(), null, ctx)).status).toBe(405);
  });
});

describe("POST /api/pause", () => {
  it("turns the kill switch on and off", async () => {
    const on = await route("POST", "/api/pause", q(), JSON.stringify({ paused: true }), ctx);
    expect(on.json).toEqual({ paused: true });
    expect(isPaused(ctx.paths)).toBe(true);

    const off = await route("POST", "/api/pause", q(), JSON.stringify({ paused: false }), ctx);
    expect(off.json).toEqual({ paused: false });
    expect(isPaused(ctx.paths)).toBe(false);
  });

  it("400s a non-boolean", async () => {
    const r = await route("POST", "/api/pause", q(), JSON.stringify({ paused: "yes" }), ctx);
    expect(r.status).toBe(400);
  });
});

describe("unknown routes", () => {
  it("404s", async () => {
    expect((await route("GET", "/api/nope", q(), null, ctx)).status).toBe(404);
  });
});
