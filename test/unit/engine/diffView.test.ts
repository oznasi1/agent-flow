import { describe, it, expect, vi } from "vitest";
import { BASE_SCHEME, baseUri, TaskBaseContentProvider } from "../../../src/engine/diffView";
import { Uri } from "../../_mocks/vscode";

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

  it("survives the serialize-and-reparse cycle the editor puts a URI through", () => {
    // A URI reaches the provider as a string that VS Code reparsed, not as the
    // object `baseUri` returned — so the JSON in `query` has to come back out
    // through percent-encoding intact. The punctuation here is the encoding's
    // whole point: `?` would otherwise start a second query and `#` a fragment.
    h.showFileAtRef.mockReturnValue("body\n");
    const file = "docs/why? #1 is 100% done.md";
    const reparsed = Uri.parse(baseUri("/r/svc", "abc123", file).toString());
    const content = new TaskBaseContentProvider().provideTextDocumentContent(reparsed as never);
    expect(h.showFileAtRef).toHaveBeenCalledWith("/r/svc", "abc123", file);
    expect(content).toBe("body\n");
  });

  it("serves empty for a URI it cannot decode instead of throwing", () => {
    const p = new TaskBaseContentProvider();
    expect(p.provideTextDocumentContent({ query: "not json" } as never)).toBe("");
  });
});
