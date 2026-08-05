import { describe, expect, it } from "vitest";
import { makeFixtureConnector } from "../../_helpers/fixtureConnector";
import { serializeCaps } from "../../../src/tasks/provider";

describe("fixture connector", () => {
  it("declares no optional capability", () => {
    const caps = makeFixtureConnector().provider().caps;
    expect(caps.labels).toBeUndefined();
    expect(caps.sprints).toBeUndefined();
    expect(caps.components).toBeUndefined();
    expect(caps.sizes).toBe(false);
    expect(caps.supportedFilters).toEqual(["mine", "all"]);
  });

  it("serializes to all-false booleans", () => {
    expect(serializeCaps(makeFixtureConnector().provider().caps)).toEqual({
      supportedFilters: ["mine", "all"], sizes: false,
      labels: false, sprints: false, components: false,
    });
  });

  it("returns tasks with no sprint, components or estimate", async () => {
    const [t] = await makeFixtureConnector().provider().list("all", "any");
    expect(t.sprint).toBeNull();
    expect(t.components).toEqual([]);
    expect(t.estimateSeconds).toBeNull();
  });

  it("moves status with no field prompts and no recovery", async () => {
    const p = makeFixtureConnector().provider();
    const targets = await p.statusTargets("FX-1");
    expect(targets.every((t) => t.fields.length === 0)).toBe(true);
    await expect(p.moveTo("FX-1", targets[0].id, {})).resolves.toBeUndefined();
  });

  it("declines to recover a key from any url", () => {
    expect(makeFixtureConnector().keyFromUrl("https://fixture.test/t/FX-1")).toBe("FX-1");
    expect(makeFixtureConnector().keyFromUrl("https://x.atlassian.net/browse/A-1")).toBeNull();
  });
});
