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

function writeLanded(id: string, sha: string = "a1b2c3d4e5f6a7b8c9d0"): void {
  fs.writeFileSync(
    path.join(ctx.paths.landed, `${id}.json`),
    JSON.stringify({
      id,
      cycle: "2026-07-31T17:09",
      role: "company-architect",
      title: "Test landed record",
      sha,
      landed_at: "2026-07-31T17:41:02Z",
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

/**
 * Every route on the board, its one allowed method, and a well-formed body for
 * it. Table-driven so the token gate and the method guard are pinned across
 * the whole surface at once, and so a future task adds coverage for a new
 * route just by adding a row here. `assertUnaffected`, where given, proves a
 * rejected request actually left the store alone rather than merely
 * returning the right status by coincidence.
 */
interface RouteSpec {
  path: string;
  method: "GET" | "POST";
  body: string | null;
  assertUnaffected?: () => void;
}

const ROUTES: RouteSpec[] = [
  { path: "/", method: "GET", body: null },
  { path: "/api/queue", method: "GET", body: null },
  { path: "/api/artifact", method: "GET", body: null },
  {
    path: "/api/decision",
    method: "POST",
    body: JSON.stringify({ id: "hero", verdict: "approve", note: "" }),
    assertUnaffected: () => expect(readDecisions(ctx.paths)).toEqual([]),
  },
  {
    path: "/api/pause",
    method: "POST",
    body: JSON.stringify({ paused: true }),
    assertUnaffected: () => expect(isPaused(ctx.paths)).toBe(false),
  },
  {
    path: "/api/cycle",
    method: "POST",
    body: JSON.stringify({ mode: "full" }),
    assertUnaffected: () => expect(ctx.spawnCycle).not.toHaveBeenCalled(),
  },
  {
    path: "/api/undo",
    method: "POST",
    body: JSON.stringify({ id: "hero" }),
    assertUnaffected: () => expect(ctx.gitRevert).not.toHaveBeenCalled(),
  },
];

describe("token gate", () => {
  it("refuses every request without the key", async () => {
    for (const [method, url] of [
      ["GET", "/"],
      ["GET", "/api/queue"],
      ["POST", "/api/decision"],
    ] as const) {
      const r = await route(method, url, q(null), "{}", null, ctx);
      expect(r.status).toBe(401);
    }
  });

  it("refuses a wrong key", async () => {
    expect((await route("GET", "/api/queue", q("wrong"), null, null, ctx)).status).toBe(401);
  });
});

describe("the token comparison", () => {
  it("answers a same-length wrong key and a short key alike, without throwing", async () => {
    // Same length as the token, so this goes through the constant-time compare
    // rather than the length guard in front of it.
    expect((await route("GET", "/api/queue", q("s3creT"), null, null, ctx)).status).toBe(401);
    // Shorter. timingSafeEqual throws on unequal lengths, so the guard has to
    // answer this one — an escaping exception would surface as a 500.
    expect((await route("GET", "/api/queue", q("s3c"), null, null, ctx)).status).toBe(401);
    expect((await route("GET", "/api/queue", q(KEY), null, null, ctx)).status).toBe(200);
  });
});

describe("GET /", () => {
  it("serves the board page", async () => {
    const r = await route("GET", "/", q(), null, null, ctx);
    expect(r.status).toBe(200);
    expect(r.html).toContain("<!doctype html>");
  });
});

describe("GET /api/queue", () => {
  it("returns pending items, landed records, pause state and last cycle", async () => {
    writeItem("hero");
    const r = await route("GET", "/api/queue", q(), null, null, ctx);
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
    const r = await route("GET", "/api/queue", q(), null, null, ctx);
    expect((r.json as { quarantined: unknown[] }).quarantined).toHaveLength(1);
  });
});

describe("GET /api/artifact", () => {
  it("returns the resolved artifact for a pending item", async () => {
    writeItem("hero");
    const r = await route("GET", "/api/artifact", new URLSearchParams(`key=${KEY}&id=hero`), null, null, ctx);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ type: "text", content: "a draft", truncated: false });
  });

  it("404s an unknown id", async () => {
    const r = await route("GET", "/api/artifact", new URLSearchParams(`key=${KEY}&id=ghost`), null, null, ctx);
    expect(r.status).toBe(404);
  });

  it("400s a missing id", async () => {
    const r = await route("GET", "/api/artifact", q(), null, null, ctx);
    expect(r.status).toBe(400);
  });

  it("400s an artifact that cannot be read", async () => {
    writeItem("bad", { artifact: { type: "text", path: "../../../etc/passwd" } });
    const r = await route("GET", "/api/artifact", new URLSearchParams(`key=${KEY}&id=bad`), null, null, ctx);
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
      null,
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
      null,
      ctx,
    );
    expect(r.status).toBe(400);
    expect(readDecisions(ctx.paths)).toEqual([]);
  });

  it("400s malformed JSON", async () => {
    const r = await route("POST", "/api/decision", q(), "{ nope", null, ctx);
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: expect.stringContaining("json") });
  });

  it("400s a body that is not an object", async () => {
    const r = await route("POST", "/api/decision", q(), "[]", null, ctx);
    expect(r.status).toBe(400);
  });

  it("405s a GET", async () => {
    expect((await route("GET", "/api/decision", q(), null, null, ctx)).status).toBe(405);
  });
});

describe("POST /api/pause", () => {
  it("turns the kill switch on and off", async () => {
    const on = await route("POST", "/api/pause", q(), JSON.stringify({ paused: true }), null, ctx);
    expect(on.json).toEqual({ paused: true });
    expect(isPaused(ctx.paths)).toBe(true);

    const off = await route("POST", "/api/pause", q(), JSON.stringify({ paused: false }), null, ctx);
    expect(off.json).toEqual({ paused: false });
    expect(isPaused(ctx.paths)).toBe(false);
  });

  it("400s a non-boolean", async () => {
    const r = await route("POST", "/api/pause", q(), JSON.stringify({ paused: "yes" }), null, ctx);
    expect(r.status).toBe(400);
  });
});

describe("unknown routes", () => {
  it("404s", async () => {
    expect((await route("GET", "/api/nope", q(), null, null, ctx)).status).toBe(404);
  });
});

describe("route table: token gate and method guard", () => {
  // A pending "hero" item exists for every row so that, if the gate or guard
  // were ever broken, the mutating routes (/api/decision, /api/pause) would
  // actually be able to succeed rather than being incidentally blocked by
  // some other validation (e.g. "no pending item").
  // A landed "hero" record also exists so the /api/undo side-effect assertion
  // is live: gitRevert is actually reachable when the token gate is removed.
  beforeEach(() => {
    writeItem("hero");
    writeLanded("hero");
  });

  it.each(ROUTES)("$method $path rejects a missing or wrong key with 401 and no side effect", async (spec) => {
    const noKey = await route(spec.method, spec.path, q(null), spec.body, null, ctx);
    expect(noKey.status).toBe(401);
    spec.assertUnaffected?.();

    const wrongKey = await route(spec.method, spec.path, q("wrong"), spec.body, null, ctx);
    expect(wrongKey.status).toBe(401);
    spec.assertUnaffected?.();
  });

  it.each(ROUTES)("$method $path rejects the opposite method with 405, not 404", async (spec) => {
    const wrongMethod = spec.method === "GET" ? "POST" : "GET";
    const r = await route(wrongMethod, spec.path, q(), spec.body, null, ctx);
    expect(r.status).toBe(405);
  });
});

/**
 * The token is not a defence against a forged write: a POST with a JSON body
 * and no custom headers is CORS-simple, so any page in the browser can send it
 * with `mode: "no-cors"` and have it executed without ever reading the reply.
 * Only the browser's own `Sec-Fetch-Site` label can tell those apart.
 */
describe("route table: cross-site writes", () => {
  const WRITES = ROUTES.filter((r) => r.method === "POST");

  beforeEach(() => {
    writeItem("hero");
    writeLanded("hero");
  });

  it.each(WRITES)("$method $path refuses a browser request from elsewhere, with no side effect", async (spec) => {
    for (const site of ["cross-site", "same-site", "none"]) {
      const r = await route(spec.method, spec.path, q(), spec.body, site, ctx);
      expect(r.status).toBe(403);
      expect(r.json).toMatchObject({ error: expect.stringContaining(site) });
      spec.assertUnaffected?.();
    }
  });

  it.each(WRITES)("$method $path accepts the board page's own request", async (spec) => {
    const r = await route(spec.method, spec.path, q(), spec.body, "same-origin", ctx);
    expect(r.status).not.toBe(403);
  });

  it.each(WRITES)("$method $path accepts a caller that sends no such header at all", async (spec) => {
    // curl, a script, a test — not a browser, and the board has to stay
    // scriptable, so absent cannot fail closed.
    const r = await route(spec.method, spec.path, q(), spec.body, null, ctx);
    expect(r.status).not.toBe(403);
  });

  it("still serves a cross-site GET, which can forge nothing and cannot be read", async () => {
    const r = await route("GET", "/api/queue", q(), null, "cross-site", ctx);
    expect(r.status).toBe(200);
  });

  it("answers a cross-site request with a bad key as 401, not 403", async () => {
    const r = await route("POST", "/api/pause", q("wrong"), "{}", "cross-site", ctx);
    expect(r.status).toBe(401);
  });
});
