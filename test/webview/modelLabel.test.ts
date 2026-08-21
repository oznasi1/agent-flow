import { describe, it, expect } from "vitest";
import { modelLabel } from "../../src/webview/modelLabel";

describe("modelLabel", () => {
  it("drops the vendor prefix", () => {
    expect(modelLabel("claude-opus-5")).toBe("opus-5");
    expect(modelLabel("claude-fable-5")).toBe("fable-5");
  });

  it("drops a trailing build date", () => {
    expect(modelLabel("claude-3-5-haiku-20241022")).toBe("3-5-haiku");
  });

  it("leaves a model it does not recognise verbatim", () => {
    // Better an unfamiliar name in full than a mangled one that reads like a
    // different model.
    expect(modelLabel("gpt-5-codex")).toBe("gpt-5-codex");
  });

  it("does not mistake a version segment for a date", () => {
    expect(modelLabel("claude-haiku-4-5")).toBe("haiku-4-5");
  });
});
