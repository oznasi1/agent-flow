import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { collect } from "../../../scripts/reach/collect.mjs";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const OK_BODIES: Record<string, unknown> = {
  "traffic/views": { views: [{ timestamp: "2026-08-21T00:00:00Z", count: 18, uniques: 3 }] },
  "traffic/clones": { clones: [{ timestamp: "2026-08-21T00:00:00Z", count: 20, uniques: 7 }] },
  "traffic/popular/referrers": [{ referrer: "Google", count: 21, uniques: 3 }],
  "traffic/popular/paths": [{ path: "/oznasi1/agent-flow", count: 34, uniques: 6 }],
  stargazers: [{ starred_at: "2026-07-23T08:46:16Z" }],
  openvsx: { version: "0.36.0", downloadCount: 18596, reviewCount: 4 },
  vsmarketplace: {
    results: [{ extensions: [{
      versions: [{ version: "0.36.0" }],
      statistics: [{ statisticName: "downloadCount", value: 1066 }, { statisticName: "install", value: 11 }],
    }] }],
  },
};

/** A fetch stub. `broken` names the substrings whose requests should 403.
 *  Cast to `typeof fetch`: collect() only ever calls it as fetchImpl(url, init),
 *  but the real signature's first parameter is `RequestInfo | URL`, which a
 *  narrower stub cannot satisfy contravariantly under `strict: true`. */
function stubFetch(broken: string[] = []): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (broken.some((b) => u.includes(b))) {
      return { ok: false, status: 403, json: async () => ({ message: "Forbidden" }) } as unknown as Response;
    }
    const key = Object.keys(OK_BODIES).find((k) => u.includes(k.split("/").pop()!))
      ?? (u.includes("open-vsx") ? "openvsx" : "vsmarketplace");
    return { ok: true, status: 200, json: async () => OK_BODIES[key] } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("collect", () => {
  it("writes every source on a fully successful run", async () => {
    const res = await collect({ dir, token: "t", fetchImpl: stubFetch(), now: "2026-08-22T06:17:00Z" });
    expect(res.failed).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "traffic/views.json"), "utf8"))["2026-08-21"])
      .toEqual({ count: 18, uniques: 3 });
    expect(fs.existsSync(path.join(dir, "marketplace.jsonl"))).toBe(true);
  });

  it("merges into an existing store rather than replacing it", async () => {
    fs.mkdirSync(path.join(dir, "traffic"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "traffic/views.json"),
      JSON.stringify({ "2026-07-20": { count: 9, uniques: 2 } }),
    );
    await collect({ dir, token: "t", fetchImpl: stubFetch(), now: "2026-08-22T06:17:00Z" });
    const views = JSON.parse(fs.readFileSync(path.join(dir, "traffic/views.json"), "utf8"));
    expect(views["2026-07-20"]).toEqual({ count: 9, uniques: 2 });
    expect(views["2026-08-21"]).toEqual({ count: 18, uniques: 3 });
  });

  it("NEVER writes a zero when a source fails — the file stays byte-identical", async () => {
    const seed = JSON.stringify({ "2026-08-20": { count: 10, uniques: 2 } }, null, 2) + "\n";
    fs.mkdirSync(path.join(dir, "traffic"), { recursive: true });
    fs.writeFileSync(path.join(dir, "traffic/views.json"), seed);

    const res = await collect({ dir, token: "t", fetchImpl: stubFetch(["traffic/views"]), now: "2026-08-22T06:17:00Z" });

    expect(fs.readFileSync(path.join(dir, "traffic/views.json"), "utf8")).toBe(seed);
    expect(res.failed.map((f) => f.source)).toContain("views");
  });

  it("lands the sibling sources even when one fails", async () => {
    const res = await collect({ dir, token: "t", fetchImpl: stubFetch(["traffic/views"]), now: "2026-08-22T06:17:00Z" });
    expect(fs.existsSync(path.join(dir, "traffic/clones.json"))).toBe(true);
    expect(res.ok).toContain("clones");
  });

  it("records firstCollected once and never moves it", async () => {
    await collect({ dir, token: "t", fetchImpl: stubFetch(), now: "2026-08-22T06:17:00Z" });
    await collect({ dir, token: "t", fetchImpl: stubFetch(), now: "2026-09-01T06:17:00Z" });
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
    expect(meta.firstCollected).toBe("2026-08-22T06:17:00Z");
    expect(meta.lastRun).toBe("2026-09-01T06:17:00Z");
  });

  it("appends one marketplace line per run", async () => {
    await collect({ dir, token: "t", fetchImpl: stubFetch(), now: "2026-08-22T06:17:00Z" });
    await collect({ dir, token: "t", fetchImpl: stubFetch(), now: "2026-08-23T06:17:00Z" });
    const lines = fs.readFileSync(path.join(dir, "marketplace.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
