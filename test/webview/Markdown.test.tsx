// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { Markdown } from "../../src/webview/Markdown";
import { send } from "../../src/webview/vscodeApi";

const sent = vi.mocked(send);
beforeEach(() => sent.mockClear());

describe("Markdown", () => {
  it("renders headings, paragraphs and emphasis as elements", () => {
    const { container } = render(<Markdown text={"# Title\n\nsome **bold** and *soft* words"} />);
    expect(container.querySelector("h1")).toHaveTextContent("Title");
    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container.querySelector("em")).toHaveTextContent("soft");
  });

  it("renders lists, quotes, rules and code fences", () => {
    const { container } = render(
      <Markdown text={"- one\n- two\n\n> quoted\n\n---\n\n```js\nconst a = 1;\n```"} />,
    );
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.querySelector("blockquote")).toHaveTextContent("quoted");
    expect(container.querySelector("hr")).toBeInTheDocument();
    expect(container.querySelector("pre code")).toHaveTextContent("const a = 1;");
  });

  it("renders an ordered list as an ol", () => {
    const { container } = render(<Markdown text={"1. one\n2. two"} />);
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
  });

  it("renders a table with a header row", () => {
    const { container } = render(<Markdown text={"| a | b |\n| - | - |\n| 1 | 2 |"} />);
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelectorAll("tbody td")).toHaveLength(2);
  });

  it("opens an http link through the host instead of navigating", () => {
    render(<Markdown text="[docs](https://x.dev/a)" />);
    fireEvent.click(screen.getByText("docs"));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://x.dev/a" });
  });

  // Security: marketplace files are third-party content.
  it("never builds DOM from raw source — a script tag stays text", () => {
    const { container } = render(<Markdown text={"<script>alert(1)</script>\n"} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("renders a javascript: link as inert text with no anchor", () => {
    const { container } = render(<Markdown text="[click](javascript:alert(1))" />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("click");
  });

  it("renders nothing for empty text", () => {
    const { container } = render(<Markdown text="" />);
    expect(container.querySelector(".md")!.childNodes).toHaveLength(0);
  });
});
