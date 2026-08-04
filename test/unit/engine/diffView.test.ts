import { describe, it, expect, vi } from "vitest";
import { BASE_SCHEME, baseUri, TaskBaseContentProvider } from "../../../src/engine/diffView";

const h = vi.hoisted(() => ({ showFileAtRef: vi.fn((_r: string, _ref: string, _f: string) => "") }));
vi.mock("../../../src/engine/git", () => ({
  showFileAtRef: h.showFileAtRef,
  taskDiffBase: vi.fn(() => "HEAD"),
  taskChangedFiles: vi.fn(() => []),
}));

describe("baseUri", () => {
  it("uses the extension's own scheme so the content provider is asked", () => {
    expect(baseUri("/r/svc", "abc123", "src/a.ts").scheme).toBe(BASE_SCHEME);
  });

  it("puts the file path where a reader can see it", () => {
    expect(baseUri("/r/svc", "abc123", "src/a.ts").path).toBe("/src/a.ts");
  });

  it("round-trips the repo, ref and file through the provider", () => {
    h.showFileAtRef.mockReturnValue("body\n");
    const content = new TaskBaseContentProvider().provideTextDocumentContent(
      baseUri("/r/svc", "abc123", "src/a.ts") as never,
    );
    expect(h.showFileAtRef).toHaveBeenCalledWith("/r/svc", "abc123", "src/a.ts");
    expect(content).toBe("body\n");
  });

  it("round-trips a path containing spaces", () => {
    new TaskBaseContentProvider().provideTextDocumentContent(
      baseUri("/r/svc", "abc123", "docs/old name.md") as never,
    );
    expect(h.showFileAtRef).toHaveBeenCalledWith("/r/svc", "abc123", "docs/old name.md");
  });

  it("serves empty for a URI it cannot decode instead of throwing", () => {
    const p = new TaskBaseContentProvider();
    expect(p.provideTextDocumentContent({ query: "not json" } as never)).toBe("");
  });
});
