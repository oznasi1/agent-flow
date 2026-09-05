import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { consented, identityFile, readIdentity, sendHeadless } from "../../../src/headless/telemetry";
import { UsageEvent } from "../../../src/telemetry/events";

const TICK: UsageEvent = {
  name: "headless_tick", dry_run: false, flow_count: 2, armed_count: 1,
  fired: 1, notified: 0, errored: 0, expired: 0,
  needs_editor: 0, needs_consent: 0, disarmed_at_ceiling: 0, duration_ms: 12,
};

/** A fetch that records what was posted and answers the way PostHog does. */
function fakeFetch() {
  const calls: { url: string; body: unknown }[] = [];
  const impl = vi.fn(async (url: unknown, init?: unknown) => {
    const raw = (init as { body?: string } | undefined)?.body;
    calls.push({ url: String(url), body: raw ? JSON.parse(raw) : undefined });
    return { ok: true, status: 200, text: async () => '{"status":"Ok"}' } as unknown as Response;
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

describe("consented — both gates, read from settings.json", () => {
  it("defaults to on, the way the editor defaults both settings", () => {
    expect(consented({})).toBe(true);
  });

  it("honours agentFlow.telemetry.enabled written flat, as the settings UI writes it", () => {
    expect(consented({ "agentFlow.telemetry.enabled": false })).toBe(false);
    expect(consented({ "agentFlow.telemetry.enabled": true })).toBe(true);
  });

  it("honours the same setting nested, as a hand-organised file reads", () => {
    expect(consented({ agentFlow: { "telemetry.enabled": false } })).toBe(false);
    expect(consented({ agentFlow: { telemetry: { enabled: false } } })).toBe(false);
    expect(consented({ agentFlow: { telemetry: { enabled: true } } })).toBe(true);
  });

  it("refuses on the EDITOR's own telemetry level, which nothing else enforces out here", () => {
    // In a window, TelemetryLogger applies this before our setting is consulted.
    // There is no logger in a bare node process, so this file is the only thing
    // standing between a user who set telemetryLevel: "off" and a tick that
    // reports anyway. "error" and "crash" admit error events only, and a tick
    // sends a usage event or nothing.
    for (const level of ["off", "error", "crash"]) {
      expect(consented({ "telemetry.telemetryLevel": level })).toBe(false);
      // Even with our own setting explicitly on: the editor's gate outranks it.
      expect(consented({ "telemetry.telemetryLevel": level, "agentFlow.telemetry.enabled": true })).toBe(false);
    }
    expect(consented({ "telemetry.telemetryLevel": "all" })).toBe(true);
  });

  it("ignores a non-boolean value rather than reading it as a no", () => {
    // A hand-edited file can hold anything; `"false"` is not `false`, and
    // guessing at it either way would be inventing consent or inventing a
    // refusal. Falls through to the default, exactly as an absent key does.
    expect(consented({ "agentFlow.telemetry.enabled": "false" })).toBe(true);
  });
});

describe("readIdentity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-tick-tel-"));

  it("reads the id the extension left", () => {
    const f = path.join(dir, "ok.json");
    fs.writeFileSync(f, JSON.stringify({ distinctId: "machine-1" }));
    expect(readIdentity(f)).toEqual({ distinctId: "machine-1" });
  });

  it("returns nothing for an absent file — the ordinary case, not an error", () => {
    expect(readIdentity(path.join(dir, "nope.json"))).toBeUndefined();
  });

  it("returns nothing for junk, an empty id, or a wrong type, rather than throwing", () => {
    const cases = ["not json at all", "{}", '{"distinctId":""}', '{"distinctId":42}', "[]"];
    for (const [i, text] of cases.entries()) {
      const f = path.join(dir, `bad${i}.json`);
      fs.writeFileSync(f, text);
      expect(readIdentity(f)).toBeUndefined();
    }
  });

  it("sits beside the flows, under ~/.agentflow", () => {
    expect(identityFile("/home/x/.agentflow/flows")).toBe(path.join("/home/x/.agentflow", "telemetry.json"));
    expect(identityFile()).toBe(path.join(os.homedir(), ".agentflow", "telemetry.json"));
  });
});

describe("sendHeadless", () => {
  const log = () => undefined;

  it("sends one event and flushes it before returning", async () => {
    // Awaited on purpose: this process exits immediately after, and an event
    // still sitting in the batch queue is a lost one.
    const { calls, impl } = fakeFetch();
    await sendHeadless(TICK, { raw: {}, log, identity: { distinctId: "m1" }, fetchImpl: impl });
    expect(calls).toHaveLength(1);
    const body = calls[0].body as { batch: { event: string; properties: Record<string, unknown> }[] };
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0].event).toBe("headless_tick");
    expect(body.batch[0].properties.fired).toBe(1);
    expect(body.batch[0].properties.duration_ms).toBe(12);
  });

  it("sends NOTHING when the settings withhold consent", async () => {
    const { calls, impl } = fakeFetch();
    await sendHeadless(TICK, {
      raw: { "agentFlow.telemetry.enabled": false }, log, identity: { distinctId: "m1" }, fetchImpl: impl,
    });
    expect(calls).toEqual([]);
  });

  it("sends NOTHING when the extension has left no identity file", async () => {
    // The tick mints no identifier of its own — one that did would report as a
    // brand-new user on every cron run. No file means the extension has never
    // run here with telemetry on, and that install never agreed to be counted.
    const { calls, impl } = fakeFetch();
    await sendHeadless(TICK, { raw: {}, log, identity: undefined, fetchImpl: impl });
    expect(calls).toEqual([]);
  });

  it("marks itself as a tick, not as an editor window", async () => {
    // A headless event must never be mistaken for one from a window: there is no
    // editor session, so it carries no session_id, and the host fields name the
    // shell rather than pretending to be an editor.
    const { calls, impl } = fakeFetch();
    await sendHeadless(TICK, { raw: {}, log, identity: { distinctId: "m1" }, fetchImpl: impl });
    const props = (calls[0].body as { batch: { properties: Record<string, unknown> }[] }).batch[0].properties;
    expect(props.app_name).toBe("agentflow-tick");
    expect(props.app_host).toBe("cli");
    expect(props.env_type).toBe("production");
    expect(props.session_id).toBeUndefined();
    expect(props.distinct_id).toBe("m1");
  });

  it("never throws when the network fails, and never blocks the caller", async () => {
    // The tick's job is the pass. Reporting on it is the part allowed to fail.
    const impl = (async () => { throw new Error("no network"); }) as unknown as typeof fetch;
    await expect(
      sendHeadless(TICK, { raw: {}, log, identity: { distinctId: "m1" }, fetchImpl: impl }),
    ).resolves.toBeUndefined();
  });
});
