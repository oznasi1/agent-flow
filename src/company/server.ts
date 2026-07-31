import * as http from "http";
import * as crypto from "crypto";
import { CompanyPaths } from "./paths";
import { boardHtml } from "./boardHtml";
import {
  acknowledgeLanded,
  isPaused,
  lastCycle,
  readLanded,
  readQueue,
  recordVerdict,
  resolveArtifact,
  setPaused,
} from "./queue";

export const CYCLE_MODES = ["full", "apply"] as const;
export type CycleMode = (typeof CYCLE_MODES)[number];

function isCycleMode(value: unknown): value is CycleMode {
  return CYCLE_MODES.includes(value as CycleMode);
}

export interface RunnerResult {
  ok: boolean;
  detail: string;
}

/**
 * Everything the routes need. The two runners are injected so tests never spawn
 * a process, and so phase B can supply the real cycle script by changing only
 * `boardMain.ts`.
 */
export interface BoardContext {
  paths: CompanyPaths;
  token: string;
  spawnCycle: (mode: CycleMode) => Promise<RunnerResult>;
  gitRevert: (sha: string) => Promise<RunnerResult>;
}

export interface RouteResult {
  status: number;
  json?: unknown;
  html?: string;
}

function parseBody(body: string | null): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body === null || body.trim().length === 0) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

/**
 * Compares the presented key to the token without leaking how much of it
 * matched. A length mismatch is answered directly because timingSafeEqual
 * throws on buffers of different sizes, and the token's length is fixed and
 * public anyway.
 */
function tokenMatches(presented: string | null, token: string): boolean {
  if (presented === null) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.byteLength !== b.byteLength) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * True when a browser tells us this mutating request came from somewhere other
 * than the board itself.
 *
 * The token alone is not enough. A POST with a JSON body and no custom headers
 * is a CORS-simple request: any page in the browser can send it with
 * `mode: "no-cors"`, no preflight, and it is delivered and executed — the
 * attacker never has to read the response, only cause the write. So any page
 * that learns the URL (from a referrer, a shared screen, shell history) can
 * forge verdicts.
 *
 * `Sec-Fetch-Site` is set by the browser and cannot be spoofed by page script.
 * Absent means the caller is not a browser at all — curl, a script, an
 * integration test — and must keep working, so absent is allowed and only
 * present-and-not-same-origin is refused.
 */
function isCrossSite(method: string, secFetchSite: string | null): boolean {
  if (method === "GET" || method === "HEAD") return false;
  return secFetchSite !== null && secFetchSite !== "same-origin";
}

export async function route(
  method: string,
  urlPath: string,
  query: URLSearchParams,
  body: string | null,
  secFetchSite: string | null,
  ctx: BoardContext,
): Promise<RouteResult> {
  if (!tokenMatches(query.get("key"), ctx.token)) {
    return { status: 401, json: { error: "bad or missing key" } };
  }

  if (isCrossSite(method, secFetchSite)) {
    return {
      status: 403,
      json: { error: `refused a ${secFetchSite} request — the board only accepts writes from its own page` },
    };
  }

  if (urlPath === "/") {
    if (method !== "GET") return { status: 405, json: { error: "use GET" } };
    return { status: 200, html: boardHtml() };
  }

  if (urlPath === "/api/queue") {
    if (method !== "GET") return { status: 405, json: { error: "use GET" } };
    const { items, quarantined } = readQueue(ctx.paths);
    return {
      status: 200,
      json: {
        pending: items,
        landed: readLanded(ctx.paths),
        quarantined,
        paused: isPaused(ctx.paths),
        lastCycle: lastCycle(ctx.paths),
      },
    };
  }

  if (urlPath === "/api/artifact") {
    if (method !== "GET") return { status: 405, json: { error: "use GET" } };
    const id = query.get("id");
    if (id === null || id.length === 0) return { status: 400, json: { error: "id is required" } };
    const item = readQueue(ctx.paths).items.find((i) => i.id === id);
    if (item === undefined) return { status: 404, json: { error: `no pending item "${id}"` } };
    const resolved = resolveArtifact(ctx.paths, item);
    if (!resolved.ok) return { status: 400, json: { error: resolved.error } };
    return { status: 200, json: resolved.artifact };
  }

  if (urlPath === "/api/decision") {
    if (method !== "POST") return { status: 405, json: { error: "use POST" } };
    const parsed = parseBody(body);
    if (!parsed.ok) return { status: 400, json: { error: "body must be a json object" } };
    const { id, verdict, note } = parsed.value;
    if (typeof id !== "string" || typeof verdict !== "string") {
      return { status: 400, json: { error: "id and verdict are required" } };
    }
    const result = recordVerdict(
      ctx.paths,
      id,
      verdict,
      typeof note === "string" ? note : "",
    );
    if (!result.ok) return { status: 400, json: { error: result.error } };
    return { status: 200, json: { ok: true } };
  }

  if (urlPath === "/api/pause") {
    if (method !== "POST") return { status: 405, json: { error: "use POST" } };
    const parsed = parseBody(body);
    if (!parsed.ok) return { status: 400, json: { error: "body must be a json object" } };
    if (typeof parsed.value.paused !== "boolean") {
      return { status: 400, json: { error: "paused must be a boolean" } };
    }
    return { status: 200, json: { paused: setPaused(ctx.paths, parsed.value.paused) } };
  }

  if (urlPath === "/api/cycle") {
    if (method !== "POST") return { status: 405, json: { error: "use POST" } };
    const parsed = parseBody(body);
    if (!parsed.ok) return { status: 400, json: { error: "body must be a json object" } };
    const mode = parsed.value.mode === undefined ? "full" : parsed.value.mode;
    if (!isCycleMode(mode)) {
      const allowed = CYCLE_MODES.map((m) => `"${m}"`).join(" or ");
      return { status: 400, json: { error: `mode must be ${allowed}` } };
    }
    // The kill switch outranks the button.
    if (isPaused(ctx.paths)) {
      return { status: 409, json: { error: "the company is paused — unpause to run a cycle" } };
    }
    const result = await ctx.spawnCycle(mode);
    return { status: 200, json: { ok: result.ok, detail: result.detail } };
  }

  if (urlPath === "/api/undo") {
    if (method !== "POST") return { status: 405, json: { error: "use POST" } };
    const parsed = parseBody(body);
    if (!parsed.ok) return { status: 400, json: { error: "body must be a json object" } };
    const id = parsed.value.id;
    if (typeof id !== "string" || id.length === 0) {
      return { status: 400, json: { error: "id is required" } };
    }
    const record = readLanded(ctx.paths).find((r) => r.id === id);
    if (record === undefined) return { status: 404, json: { error: `no landed record "${id}"` } };
    const result = await ctx.gitRevert(record.sha);
    // Only clear the record once the revert actually succeeded, so a conflict
    // leaves the Undo button available rather than losing the sha.
    if (result.ok) acknowledgeLanded(ctx.paths, id);
    return { status: 200, json: { ok: result.ok, detail: result.detail } };
  }

  return { status: 404, json: { error: "not found" } };
}

const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {
  override readonly name = "BodyTooLargeError";
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Drop what we have and keep draining. Destroying the request here would
        // race the 413 response and surface to the client as a socket error.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(new BodyTooLargeError("body too large"));
        return;
      }
      resolve(chunks.length === 0 ? null : Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/**
 * Reads one request header as a plain value, so `route()` never sees a
 * node:http object. Node folds repeated headers into a single comma-joined
 * string for everything except a handful of set-cookie-like names; the array
 * branch is belt and braces.
 */
function headerValue(req: http.IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

/**
 * Adapts `route()` to node:http. Bind it yourself — always to 127.0.0.1, never
 * to a public interface: this server can merge and revert commits.
 */
export function createBoardServer(ctx: BoardContext): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let body: string | null = null;
      try {
        body = await readBody(req);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          if (!res.headersSent) {
            res.writeHead(413, {
              "content-type": "application/json",
              "cache-control": "no-store",
            });
            res.end(JSON.stringify({ error: "body too large" }));
          }
          return;
        }
        // Socket/stream error from readBody — distinguish from oversize
        if (!res.headersSent) {
          res.writeHead(400, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify({ error: "bad request" }));
        }
        return;
      }

      const result = await route(
        req.method ?? "GET",
        url.pathname,
        url.searchParams,
        body,
        headerValue(req, "sec-fetch-site"),
        ctx,
      );
      // no-referrer keeps this URL — which carries the token in its query
      // string — out of every request the page or its artifacts make.
      const headers: Record<string, string> = {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      };
      if (result.html !== undefined) {
        headers["content-type"] = "text/html; charset=utf-8";
        res.writeHead(result.status, headers);
        res.end(result.html);
        return;
      }
      headers["content-type"] = "application/json";
      res.writeHead(result.status, headers);
      res.end(JSON.stringify(result.json ?? {}));
    } catch (err) {
      console.error("Board server error:", err);
      if (!res.headersSent) {
        res.writeHead(500, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ error: "internal server error" }));
      }
    }
  });
}
