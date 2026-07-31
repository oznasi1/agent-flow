import { CompanyPaths } from "./paths";
import { boardHtml } from "./boardHtml";
import {
  isPaused,
  lastCycle,
  readLanded,
  readQueue,
  recordVerdict,
  resolveArtifact,
  setPaused,
} from "./queue";

export type CycleMode = "full" | "apply";

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

export async function route(
  method: string,
  urlPath: string,
  query: URLSearchParams,
  body: string | null,
  ctx: BoardContext,
): Promise<RouteResult> {
  if (query.get("key") !== ctx.token) return { status: 401, json: { error: "bad or missing key" } };

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

  return { status: 404, json: { error: "not found" } };
}
