import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { companyPaths, ensureCompanyDirs } from "../../../src/company/paths";
import { createBoardServer, BoardContext } from "../../../src/company/server";
import { isPaused } from "../../../src/company/queue";

let root: string;
let ctx: BoardContext;
let base: string;
let server: ReturnType<typeof createBoardServer>;
const KEY = "s3cret";

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-company-http-"));
  const paths = companyPaths(root);
  ensureCompanyDirs(paths);
  ctx = {
    paths,
    token: KEY,
    spawnCycle: vi.fn(async () => ({ ok: true, detail: "started" })),
    gitRevert: vi.fn(async () => ({ ok: true, detail: "reverted" })),
  };
  server = createBoardServer(ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe("createBoardServer", () => {
  it("serves the page with the key", async () => {
    const res = await fetch(`${base}/?key=${KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<!doctype html>");
  });

  it("401s without the key", async () => {
    const res = await fetch(`${base}/api/queue`);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("returns the queue as json", async () => {
    const res = await fetch(`${base}/api/queue?key=${KEY}`);
    expect(await res.json()).toMatchObject({ pending: [], paused: false });
  });

  it("reads a posted body", async () => {
    const res = await fetch(`${base}/api/pause?key=${KEY}`, {
      method: "POST",
      body: JSON.stringify({ paused: true }),
    });
    expect(await res.json()).toEqual({ paused: true });
  });

  it("413s a body over the cap without processing it", async () => {
    const res = await fetch(`${base}/api/pause?key=${KEY}`, {
      method: "POST",
      body: "x".repeat(1024 * 1024 + 10),
    });
    expect(res.status).toBe(413);
  });

  it("sends no-store so a stale queue never renders", async () => {
    const res = await fetch(`${base}/api/queue?key=${KEY}`);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("sends referrer-policy: no-referrer, since this URL carries the token", async () => {
    const page = await fetch(`${base}/?key=${KEY}`);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const api = await fetch(`${base}/api/queue?key=${KEY}`);
    expect(api.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("forwards Sec-Fetch-Site and refuses a cross-site write that has the key", async () => {
    const res = await fetch(`${base}/api/pause?key=${KEY}`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ paused: true }),
    });
    expect(res.status).toBe(403);
    expect(isPaused(ctx.paths)).toBe(false);
  });

  it("accepts the same write from the board's own page", async () => {
    const res = await fetch(`${base}/api/pause?key=${KEY}`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ paused: true }),
    });
    expect(res.status).toBe(200);
    expect(isPaused(ctx.paths)).toBe(true);
  });

  it("500s and stays alive when a handler rejects", async () => {
    // Create a context where spawnCycle rejects, triggering an unhandled error
    const errorCtx: BoardContext = {
      paths: ctx.paths,
      token: KEY,
      spawnCycle: vi.fn(async () => {
        throw new Error("synthetic handler failure");
      }),
      gitRevert: vi.fn(async () => ({ ok: true, detail: "reverted" })),
    };
    const errorServer = createBoardServer(errorCtx);
    await new Promise<void>((resolve) => errorServer.listen(0, "127.0.0.1", resolve));
    const errorBase = `http://127.0.0.1:${(errorServer.address() as AddressInfo).port}`;

    try {
      // Trigger the error by calling a handler that uses spawnCycle
      const errRes = await fetch(`${errorBase}/api/cycle?key=${KEY}`, {
        method: "POST",
        body: JSON.stringify({ mode: "full" }),
      });
      expect(errRes.status).toBe(500);
      expect(await errRes.json()).toEqual({ error: "internal server error" });

      // Verify the server is still alive by making a successful request
      const liveRes = await fetch(`${errorBase}/api/queue?key=${KEY}`);
      expect(liveRes.status).toBe(200);
      expect(await liveRes.json()).toMatchObject({ pending: [], paused: false });
    } finally {
      await new Promise<void>((resolve) => errorServer.close(() => resolve()));
    }
  });
});
