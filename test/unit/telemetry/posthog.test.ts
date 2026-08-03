import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BATCH_SIZE,
  createPostHogSender,
  FLUSH_INTERVAL_MS,
  QUEUE_CAP,
  RETRY_DELAY_MS,
  stackDigest,
} from "../../../src/telemetry/posthog";

function makeDeps(over: Partial<Parameters<typeof createPostHogSender>[0]> = {}) {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }));
  return {
    deps: {
      apiKey: "phc_test",
      host: "https://ph.test",
      distinctId: "m1",
      log: vi.fn(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_700_000_000_000,
      isConsented: () => true,
      commonProperties: { session_id: "s1", env_type: "development" },
      ...over,
    },
    fetchImpl,
  };
}

async function fill(sender: ReturnType<typeof createPostHogSender>, n: number) {
  for (let i = 0; i < n; i++) sender.sendEventData("e", { i });
  await Promise.resolve();
}

describe("createPostHogSender", () => {
  beforeEach(() => vi.useRealTimers());

  it("does not send before the batch fills", async () => {
    const { deps, fetchImpl } = makeDeps();
    await fill(createPostHogSender(deps), BATCH_SIZE - 1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs the PostHog /batch/ contract once the batch fills", async () => {
    const { deps, fetchImpl } = makeDeps();
    const sender = createPostHogSender(deps);
    await fill(sender, BATCH_SIZE);
    await sender.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ph.test/batch/");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.api_key).toBe("phc_test");
    expect(body.batch).toHaveLength(BATCH_SIZE);
    expect(body.batch[0].event).toBe("e");
    expect(body.batch[0].properties.distinct_id).toBe("m1");
    expect(body.batch[0].timestamp).toBe("2023-11-14T22:13:20.000Z");
  });

  it("no-ops when the api key is still the placeholder", async () => {
    const { deps, fetchImpl } = makeDeps({ apiKey: "phc_REPLACE_ME" });
    const sender = createPostHogSender(deps);
    await fill(sender, BATCH_SIZE);
    await sender.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries once on a 500, then gives up", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("boom", { status: 500 }));
    const { deps } = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const sender = createPostHogSender({ ...deps, retryDelayMs: 0 });
    sender.sendEventData("e");
    await sender.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401 — a bad key must not hammer", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("nope", { status: 401 }));
    const { deps } = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const sender = createPostHogSender({ ...deps, retryDelayMs: 0 });
    sender.sendEventData("e");
    await sender.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caps the queue and drops the oldest", async () => {
    const { deps, fetchImpl } = makeDeps();
    const sender = createPostHogSender(deps);
    for (let i = 0; i < QUEUE_CAP + 10; i++) sender.sendEventData("e", { i });
    await sender.flush();
    const sent = fetchImpl.mock.calls.flatMap(([, init]) => JSON.parse(String((init as RequestInit).body)).batch);
    expect(sent.length).toBeLessThanOrEqual(QUEUE_CAP);
    expect(sent.some((e: any) => e.properties.i === 0)).toBe(false);
    expect(sent.some((e: any) => e.properties.i === QUEUE_CAP + 9)).toBe(true);
  });

  it("drop() discards without sending", async () => {
    const { deps, fetchImpl } = makeDeps();
    const sender = createPostHogSender(deps);
    sender.sendEventData("e");
    sender.drop();
    await sender.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("swallows a rejected fetch and logs it", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error("offline"); });
    const log = vi.fn();
    const { deps } = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch, log });
    const sender = createPostHogSender({ ...deps, retryDelayMs: 0 });
    sender.sendEventData("e");
    await expect(sender.flush()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it("passes an abort signal so a hung request cannot leak", async () => {
    const { deps, fetchImpl } = makeDeps();
    const sender = createPostHogSender(deps);
    sender.sendEventData("e");
    await sender.flush();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeDefined();
  });

  it("sends nothing at all while Agent Flow Deck's own consent gate is off — including the host's unhandled-error path", async () => {
    // sendErrorData is what VS Code calls by itself for an error escaping the
    // extension host (TelemetryLoggerOptions.ignoreUnhandledErrors defaults to
    // false), so it never passes through track()/trackError() and their gates.
    // enqueue() is the only choke point that can stop it.
    const { deps, fetchImpl } = makeDeps({ isConsented: () => false });
    const sender = createPostHogSender(deps);
    sender.sendErrorData(new Error("kaboom"), {});
    await fill(sender, BATCH_SIZE);
    await sender.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resumes sending when the consent gate flips back on mid-session", async () => {
    // The gate is a function, read per event: re-enabling agentFlow.telemetry.enabled
    // in the same window must start working again, which is why consent withdrawal
    // must never dispose() the sender.
    let consented = false;
    const { deps, fetchImpl } = makeDeps({ isConsented: () => consented });
    const sender = createPostHogSender(deps);
    sender.sendErrorData(new Error("dropped while off"), {});
    await sender.flush();
    expect(fetchImpl).not.toHaveBeenCalled();

    consented = true;
    sender.sendErrorData(new Error("sent once back on"), {});
    await sender.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body.batch).toHaveLength(1); // only the post-re-enable event, not the withheld one
  });

  it("attaches the common properties to every event, whichever path queued it", async () => {
    const { deps, fetchImpl } = makeDeps();
    const sender = createPostHogSender(deps);
    sender.sendEventData("take_started", { flow_id: "f1" });
    sender.sendErrorData(new Error("kaboom"), {}); // the host's own error path
    await sender.flush();
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    const unhandled = body.batch.find((e: any) => e.event === "unhandled_error");
    expect(unhandled.properties.env_type).toBe("development");
    expect(unhandled.properties.session_id).toBe("s1");
    const usage = body.batch.find((e: any) => e.event === "take_started");
    expect(usage.properties.env_type).toBe("development");
    expect(usage.properties.session_id).toBe("s1");
    expect(usage.properties.flow_id).toBe("f1");
  });

  it("lets an event's own properties win over a common property of the same name", async () => {
    const { deps, fetchImpl } = makeDeps({ commonProperties: { env_type: "development", repo_count: 0 } });
    const sender = createPostHogSender(deps);
    sender.sendEventData("take_completed", { repo_count: 3 });
    await sender.flush();
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body.batch[0].properties.repo_count).toBe(3);
  });

  it("sends errors through sendErrorData as unhandled_error", async () => {
    const { deps, fetchImpl } = makeDeps();
    const sender = createPostHogSender(deps);
    const err = new TypeError("nope");
    err.stack = "TypeError: nope\n    at f (/Users/someone/dev/agent-flow/dist/extension.js:9:1)";
    sender.sendErrorData(err, {});
    await sender.flush();
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body.batch[0].event).toBe("unhandled_error");
    expect(body.batch[0].properties.error_class).toBe("TypeError");
    expect(body.batch[0].properties.stack_digest).toContain("dist/extension.js:9:1");
    expect(body.batch[0].properties.stack_digest).not.toContain("/Users/someone");
    expect(JSON.stringify(body)).not.toContain("nope");
  });

  it("dispose() clears the flush interval and is a hard off switch", async () => {
    vi.useFakeTimers();
    try {
      const { deps, fetchImpl } = makeDeps();
      const sender = createPostHogSender(deps);
      // Below BATCH_SIZE so nothing auto-flushes; this only arms the interval.
      sender.sendEventData("e");
      sender.dispose();
      // Even advancing well past FLUSH_INTERVAL_MS, the cleared interval must
      // never fire again.
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS * 3);
      expect(fetchImpl).not.toHaveBeenCalled();

      // A post-dispose sendEventData must not resurrect the interval or queue
      // anything — dispose() is called repeatedly and in any order here too.
      sender.sendEventData("e2");
      sender.dispose();
      sender.drop();
      await sender.flush();
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS * 3);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors the default RETRY_DELAY_MS when retryDelayMs is omitted", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        calls += 1;
        return calls === 1 ? new Response("boom", { status: 500 }) : new Response("ok", { status: 200 });
      });
      // retryDelayMs deliberately omitted so the real default (and the real
      // sleep() path) is exercised, not the tests' usual retryDelayMs: 0.
      const { deps } = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch });
      const sender = createPostHogSender(deps);
      sender.sendEventData("e");
      const flushed = sender.flush();

      // Let the first attempt (and its rejection) run.
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Just short of the default delay: still only one attempt.
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS - 1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Crossing RETRY_DELAY_MS fires the retry.
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      await flushed;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stackDigest", () => {
  it("keeps our bundled frames and strips absolute paths", () => {
    const digest = stackDigest("Error: x\n    at a (/Users/oz/dev/agent-flow/dist/extension.js:1:2)\n    at b (node:internal/foo:3:4)");
    expect(digest).toContain("dist/extension.js:1:2");
    expect(digest).not.toContain("/Users/oz");
  });

  it("retains Windows-style stack frames and normalizes separators", () => {
    const digest = stackDigest("Error: x\n    at f (C:\\Users\\bob\\dev\\agent-flow\\dist\\extension.js:1:2)");
    // Backslashes are normalized to forward slashes so the same frame groups
    // identically in PostHog regardless of the reporting OS.
    expect(digest).toContain("dist/extension.js:1:2");
    expect(digest).not.toContain("C:\\Users\\bob");
    expect(digest).not.toContain("\\");
  });

  it("returns an empty string for a missing stack", () => {
    expect(stackDigest(undefined)).toBe("");
  });

  it("truncates to 20 frames", () => {
    const stack = "Error: x\n" + Array.from({ length: 40 }, (_, i) => `    at f${i} (dist/extension.js:${i}:1)`).join("\n");
    expect(stackDigest(stack).split("\n")).toHaveLength(20);
  });
});
