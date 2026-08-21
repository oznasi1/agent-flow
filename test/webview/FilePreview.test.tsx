// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { FilePreview } from "../../src/webview/FilePreview";

describe("FilePreview", () => {
  it("renders a placeholder while the read is in flight", () => {
    render(<FilePreview file="/a/SKILL.md" cached={undefined} fence="" onOpen={vi.fn()} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("marks the in-flight read with the animated logo, and drops it once the file lands", () => {
    const { container, rerender } = render(
      <FilePreview file="/a/SKILL.md" cached={undefined} fence="" onOpen={vi.fn()} />,
    );
    expect(container.querySelector("svg.lmark")).toBeInTheDocument();
    rerender(
      <FilePreview file="/a/SKILL.md" cached={{ text: "body", truncated: false }} fence="" onOpen={vi.fn()} />,
    );
    expect(container.querySelector("svg.lmark")).not.toBeInTheDocument();
  });

  it("renders the file once it arrives", () => {
    const { container } = render(
      <FilePreview file="/a/SKILL.md" cached={{ text: "# Build\n\nbody", truncated: false }} fence="" onOpen={vi.fn()} />,
    );
    expect(container.querySelector("h1")).toHaveTextContent("Build");
  });

  it("says so when there is nothing to preview", () => {
    render(<FilePreview file="" cached={undefined} fence="" onOpen={vi.fn()} />);
    expect(screen.getByText(/nothing to preview/i)).toBeInTheDocument();
  });

  it("says so when the file came back empty", () => {
    render(<FilePreview file="/a/x.md" cached={{ text: "", truncated: false }} fence="" onOpen={vi.fn()} />);
    expect(screen.getByText(/nothing to preview/i)).toBeInTheDocument();
  });

  it("wraps the text in a code block when a fence language is given", () => {
    const { container } = render(
      <FilePreview file="/a/hooks.json" cached={{ text: '{"a":1}', truncated: false }} fence="json" onOpen={vi.fn()} />,
    );
    expect(container.querySelector("pre code")).toHaveTextContent('{"a":1}');
  });

  it("offers the editor when the file was truncated", () => {
    const onOpen = vi.fn();
    render(<FilePreview file="/a/big.md" cached={{ text: "x", truncated: true }} fence="" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /open file/i }));
    expect(onOpen).toHaveBeenCalled();
  });

  it("shows no truncation footer for a whole file", () => {
    render(<FilePreview file="/a/x.md" cached={{ text: "x", truncated: false }} fence="" onOpen={vi.fn()} />);
    expect(screen.queryByText(/truncated/i)).not.toBeInTheDocument();
  });
});
