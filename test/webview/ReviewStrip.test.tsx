// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReviewStrip } from "../../src/webview/ReviewStrip";
import type { ReviewRequest } from "../../src/types";

const mk = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  id: "CyberJackGit/aws-ops#8491", repo: "CyberJackGit/aws-ops", repoName: "aws-ops",
  number: 8491, title: "isolate renew queue", url: "https://github.com/CyberJackGit/aws-ops/pull/8491",
  author: "einavsaad", isDraft: false, createdAt: Date.now() - 5 * 86_400_000, updatedAt: Date.now(),
  additions: 350, deletions: 4, changedFiles: 7,
  ci: "passing", review: "review_required", mergeable: "clean",
  localPath: "/repos/aws-ops", runKey: null, draftPath: null,
  ...over,
});

const props = (over: Partial<React.ComponentProps<typeof ReviewStrip>> = {}) => ({
  requests: [mk()], issueCount: 1, sort: "oldest" as const, stale: false,
  expanded: null, details: {}, onExpand: vi.fn(), onSort: vi.fn(), onOpen: vi.fn(),
  collapsed: false, onCollapse: vi.fn(),
  ...over,
});

describe("ReviewStrip", () => {
  it("renders nothing when nothing is waiting", () => {
    const { container } = render(<ReviewStrip {...props({ requests: [], issueCount: 0 })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("heads the strip with the count", () => {
    render(<ReviewStrip {...props()} />);
    expect(screen.getByText(/1 PR waiting on your review/i)).toBeInTheDocument();
  });

  it("pluralises the count", () => {
    render(<ReviewStrip {...props({ requests: [mk(), mk({ id: "x#2", number: 2 })], issueCount: 2 })} />);
    expect(screen.getByText(/2 PRs waiting on your review/i)).toBeInTheDocument();
  });

  it("reports truncation when more requests exist than were returned", () => {
    render(<ReviewStrip {...props({ issueCount: 73 })} />);
    expect(screen.getByText(/showing 1 of 73/i)).toBeInTheDocument();
  });

  it("renders repo, number, title, author, size and age", () => {
    render(<ReviewStrip {...props()} />);
    expect(screen.getByText("aws-ops")).toBeInTheDocument();
    expect(screen.getByText("#8491")).toBeInTheDocument();
    expect(screen.getByText("isolate renew queue")).toBeInTheDocument();
    expect(screen.getByText("@einavsaad")).toBeInTheDocument();
    expect(screen.getByText("M")).toBeInTheDocument();       // 354 lines
    expect(screen.getByText("+350")).toBeInTheDocument();
    expect(screen.getByText("−4")).toBeInTheDocument();      // U+2212, as on the cards
    expect(screen.getByText("7 files")).toBeInTheDocument();
    expect(screen.getByText("5d")).toBeInTheDocument();
  });

  it("marks a draft", () => {
    render(<ReviewStrip {...props({ requests: [mk({ isDraft: true })] })} />);
    expect(screen.getByText("draft")).toBeInTheDocument();
  });

  it("marks a stale queue", () => {
    render(<ReviewStrip {...props({ stale: true })} />);
    expect(screen.getByText(/couldn't refresh/i)).toBeInTheDocument();
  });

  it("asks to expand a row on click, once", () => {
    const onExpand = vi.fn();
    render(<ReviewStrip {...props({ onExpand })} />);
    fireEvent.click(screen.getByText("isolate renew queue"));
    expect(onExpand).toHaveBeenCalledWith("CyberJackGit/aws-ops#8491");
  });

  it("shows failing check names once the detail arrives", () => {
    render(<ReviewStrip {...props({
      expanded: "CyberJackGit/aws-ops#8491",
      details: { "CyberJackGit/aws-ops#8491": { failing: [{ name: "e2e", url: "https://ci/e2e" }], unresolved: 2 } },
    })} />);
    expect(screen.getByText("e2e")).toBeInTheDocument();
    expect(screen.getByText(/2 open/)).toBeInTheDocument();
  });

  it("says it is loading the detail before it arrives", () => {
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", details: {} })} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("switches sort", () => {
    const onSort = vi.fn();
    render(<ReviewStrip {...props({ onSort })} />);
    fireEvent.click(screen.getByText("smallest"));
    expect(onSort).toHaveBeenCalledWith("smallest");
  });

  it("opens the PR externally", () => {
    const onOpen = vi.fn();
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", onOpen })} />);
    fireEvent.click(screen.getByText("Open PR"));
    expect(onOpen).toHaveBeenCalledWith("https://github.com/CyberJackGit/aws-ops/pull/8491");
  });

  it("hides the rows while collapsed but keeps the header", () => {
    render(<ReviewStrip {...props({ collapsed: true })} />);
    expect(screen.getByText(/1 PR waiting on your review/i)).toBeInTheDocument();
    expect(screen.queryByText("isolate renew queue")).not.toBeInTheDocument();
  });
});
