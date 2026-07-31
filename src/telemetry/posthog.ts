import * as vscode from "vscode";

export const POSTHOG_HOST = "https://us.i.posthog.com";
/** Public, write-only PostHog project ingestion key. NOT a secret — it is
 * world-readable in this OSS repo and in every published bundle. Replace the
 * placeholder with the real key; the sender no-ops while it is unset. */
export const POSTHOG_API_KEY = "phc_REPLACE_ME";
export const PLACEHOLDER_KEY = "phc_REPLACE_ME";

export const BATCH_SIZE = 20;
export const FLUSH_INTERVAL_MS = 10_000;
export const QUEUE_CAP = 100;
export const REQUEST_TIMEOUT_MS = 5_000;
export const RETRY_DELAY_MS = 2_000;
const MAX_STACK_FRAMES = 20;
const MAX_STACK_BYTES = 2_048;

export interface PostHogSenderDeps {
  apiKey?: string;
  host?: string;
  distinctId: string;
  log: (m: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Delay before the single retry on a 5xx/network failure. Defaults to
   * RETRY_DELAY_MS; tests set it to 0 to keep themselves fast. */
  retryDelayMs?: number;
}

export interface PostHogSender extends vscode.TelemetrySender {
  sendEventData(eventName: string, data?: Record<string, unknown>): void;
  sendErrorData(error: Error, data?: Record<string, unknown>): void;
  flush(): Promise<void>;
  /** Discard everything queued without sending — used when consent is withdrawn. */
  drop(): void;
  dispose(): void;
}

interface QueuedEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

/** An Error stack reduced to our own bundled frames, absolute paths stripped.
 * We ship one bundled file, so these frames are our code and contain nothing about
 * the user — unlike error.message, which routinely embeds paths and ticket keys and
 * is never sent. */
export function stackDigest(stack: string | undefined): string {
  if (!stack) return "";
  const frames = stack
    .split("\n")
    .filter((l) => l.includes("dist/extension.js"))
    .map((l) => l.replace(/\(?(?:[A-Za-z]:)?[/\\][^\s()]*?(dist[/\\]extension\.js)/g, "($1").trim())
    .slice(0, MAX_STACK_FRAMES);
  return frames.join("\n").slice(0, MAX_STACK_BYTES);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createPostHogSender(deps: PostHogSenderDeps): PostHogSender {
  const apiKey = deps.apiKey ?? POSTHOG_API_KEY;
  const host = deps.host ?? POSTHOG_HOST;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());
  const retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
  const enabled = apiKey !== PLACEHOLDER_KEY && !!apiKey;

  let queue: QueuedEvent[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  function ensureTimer(): void {
    if (timer || !enabled) return;
    timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
    // Never hold the extension host's event loop open for analytics.
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  function enqueue(event: string, properties: Record<string, unknown>): void {
    if (!enabled) return;
    queue.push({ event, properties: { ...properties, distinct_id: deps.distinctId }, timestamp: new Date(now()).toISOString() });
    if (queue.length > QUEUE_CAP) {
      const dropped = queue.length - QUEUE_CAP;
      queue = queue.slice(dropped);
      deps.log(`telemetry: queue full, dropped ${dropped} oldest event(s)`);
    }
    ensureTimer();
    if (queue.length >= BATCH_SIZE) void flush();
  }

  async function post(batch: QueuedEvent[]): Promise<void> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await doFetch(`${host}/batch/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, batch }),
        signal: controller.signal,
      });
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) {
        // 4xx is permanent — a bad key must never retry forever.
        deps.log(`telemetry: dropped ${batch.length} event(s), HTTP ${res.status}`);
        return;
      }
    } finally {
      clearTimeout(t);
    }
  }

  async function drain(): Promise<void> {
    while (queue.length) {
      const batch = queue.splice(0, BATCH_SIZE);
      try {
        await post(batch);
      } catch (e) {
        try {
          if (retryDelayMs > 0) await sleep(retryDelayMs);
          await post(batch);
        } catch (e2) {
          deps.log(`telemetry: dropped ${batch.length} event(s): ${e2 instanceof Error ? e2.message : String(e2)}`);
        }
      }
    }
  }

  function flush(): Promise<void> {
    // Serialise flushes so a batch-size trigger and the interval cannot interleave.
    inFlight = inFlight.then(drain, drain);
    return inFlight;
  }

  return {
    sendEventData(eventName: string, data?: Record<string, unknown>): void {
      enqueue(eventName, data ?? {});
    },
    sendErrorData(error: Error, data?: Record<string, unknown>): void {
      // Deliberately no error.message: messages embed paths and ticket keys.
      enqueue("unhandled_error", { ...data, error_class: error.name, stack_digest: stackDigest(error.stack) });
    },
    flush,
    drop(): void {
      if (queue.length) deps.log(`telemetry: consent withdrawn, discarded ${queue.length} queued event(s)`);
      queue = [];
    },
    dispose(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
