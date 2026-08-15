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
  requests: [mk()], issueCount: 1, sort: "oldest" as const, stale: false, loading: false,
  expanded: null, details: {}, onExpand: vi.fn(), onSort: vi.fn(), onOpen: vi.fn(),
  collapsed: false, onCollapse: vi.fn(), onLaunch: vi.fn(), onLoadDraft: vi.fn(),
  reviewWrites: false, bodies: {}, onBody: vi.fn(), onSubmit: vi.fn(),
  submitting: {}, submitFailed: {},
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

  it("opens a failing check's own URL, not the PR's", () => {
    const onOpen = vi.fn();
    render(<ReviewStrip {...props({
      expanded: "CyberJackGit/aws-ops#8491",
      details: { "CyberJackGit/aws-ops#8491": { failing: [{ name: "e2e", url: "https://ci/e2e" }], unresolved: null } },
      onOpen,
    })} />);
    fireEvent.click(screen.getByText("e2e"));
    expect(onOpen).toHaveBeenCalledWith("https://ci/e2e");
    expect(onOpen).not.toHaveBeenCalledWith("https://github.com/CyberJackGit/aws-ops/pull/8491");
  });

  it("says it is loading the detail before it arrives", () => {
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", details: {} })} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  // Regression: a failed detail fetch used to post nothing at all, so
  // `details[id]` stayed `undefined` forever and the row showed "loading…" for
  // the rest of the session. `detail: null` is the host's explicit "I tried and
  // it failed" marker — distinct from "never asked" (undefined/absent).
  it("shows a quiet note instead of loading forever when the detail fetch failed, but keeps the row's own facts", () => {
    render(<ReviewStrip {...props({
      expanded: "CyberJackGit/aws-ops#8491",
      details: { "CyberJackGit/aws-ops#8491": null },
    })} />);
    expect(screen.getByText(/couldn't load checks/i)).toBeInTheDocument();
    expect(screen.queryByText(/^loading/i)).not.toBeInTheDocument();
    // review_required + clean (this row's search-level facts) still render —
    // only the checks line depends on the failed detail call.
    expect(screen.getByText("review required")).toBeInTheDocument();
    expect(screen.getByText("clean")).toBeInTheDocument();
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

  // A handler bug like onCollapse(p.collapsed) — passing the current value straight
  // through instead of flipping it — would make every prior assertion here pass
  // regardless, since none of them ever click the toggle itself.
  it("asks to collapse when the header toggle is clicked while open", () => {
    const onCollapse = vi.fn();
    render(<ReviewStrip {...props({ collapsed: false, onCollapse })} />);
    fireEvent.click(screen.getByText(/waiting on your review/i));
    expect(onCollapse).toHaveBeenCalledWith(true);
  });

  it("asks to expand when the header toggle is clicked while collapsed", () => {
    const onCollapse = vi.fn();
    render(<ReviewStrip {...props({ collapsed: true, onCollapse })} />);
    fireEvent.click(screen.getByText(/waiting on your review/i));
    expect(onCollapse).toHaveBeenCalledWith(false);
  });

  it("offers Review with agent when the repo is checked out", () => {
    const onLaunch = vi.fn();
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", onLaunch })} />);
    fireEvent.click(screen.getByText(/Review with agent/i));
    expect(onLaunch).toHaveBeenCalledWith("CyberJackGit/aws-ops#8491");
  });

  it("still offers the agent action, with a reason in the title, when the repo is not checked out", () => {
    // Not checked out locally is not a reason to block the click: launchReview
    // (the host side) already fails this case gracefully with an explanatory
    // toast, so the button stays live and the title alone carries the caveat —
    // same reasoning as review status never gating this button either.
    const onLaunch = vi.fn();
    render(<ReviewStrip {...props({
      expanded: "CyberJackGit/aws-ops#8491",
      onLaunch,
      requests: [mk({ localPath: null })],
    })} />);
    const btn = screen.getByText(/Review with agent/i) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.title).toMatch(/isn't checked out/i);
    fireEvent.click(btn);
    expect(onLaunch).toHaveBeenCalledWith("CyberJackGit/aws-ops#8491");
  });

  it("says a review is already running", () => {
    render(<ReviewStrip {...props({ requests: [mk({ runKey: "review-aws-ops-8491" })] })} />);
    expect(screen.getByText(/reviewing/i)).toBeInTheDocument();
  });

  it("does not say a review is running when no run is in flight", () => {
    render(<ReviewStrip {...props({ requests: [mk({ runKey: null })] })} />);
    expect(screen.queryByText(/reviewing/i)).not.toBeInTheDocument();
  });

  it("offers to load the agent's draft only once the file exists", () => {
    const onLoadDraft = vi.fn();
    const { rerender } = render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", onLoadDraft })} />);
    expect(screen.queryByText(/Load agent's review/i)).not.toBeInTheDocument();
    rerender(<ReviewStrip {...props({
      expanded: "CyberJackGit/aws-ops#8491", onLoadDraft,
      requests: [mk({ draftPath: "/wt/.pick-task/REVIEW-8491.md" })],
    })} />);
    fireEvent.click(screen.getByText(/Load agent's review/i));
    expect(onLoadDraft).toHaveBeenCalledWith("CyberJackGit/aws-ops#8491");
  });

  it("renders no box and no verbs while writes are off", () => {
    const { container } = render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", reviewWrites: false })} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
    // getByRole("textbox") alone would still pass a version that renders the box
    // but hides it with CSS (e.g. display:none) — Testing Library's role query
    // excludes inaccessible elements by default, so it can't tell "absent" from
    // "hidden". A raw DOM query has no such filter and catches that regression.
    expect(container.querySelector(".rv-box")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("renders the box and three verbs when writes are on", () => {
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true })} />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByText("Approve")).toBeInTheDocument();
    expect(screen.getByText("Comment")).toBeInTheDocument();
    expect(screen.getByText("Request changes")).toBeInTheDocument();
  });

  it("disables comment and request-changes with an empty box, but not approve", () => {
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true })} />);
    expect((screen.getByText("Comment") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Request changes") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Approve") as HTMLButtonElement).disabled).toBe(false);
  });

  // The `.disabled` checks above would also pass a button styled to *look*
  // disabled (e.g. aria-disabled plus a dimming class) while its onClick still
  // fires — jsdom, like a real browser, only suppresses the click when
  // `disabled` is a genuine DOM property. Only firing the click and checking the
  // handler proves the binding actually blocks it.
  it("does not call onSubmit when a disabled verb is clicked", () => {
    const onSubmit = vi.fn();
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true, onSubmit })} />);
    fireEvent.click(screen.getByText("Comment"));
    fireEvent.click(screen.getByText("Request changes"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // Requirement is "empty OR whitespace-only". Every test above uses `""` or a
  // real word, so mutating the guard from `!body.trim()` to `!body` (whitespace
  // is truthy) would pass all of them — this is the one that catches it.
  it("disables comment and request-changes with a whitespace-only box", () => {
    render(<ReviewStrip {...props({
      expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true,
      bodies: { "CyberJackGit/aws-ops#8491": "   " },
    })} />);
    expect((screen.getByText("Comment") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Request changes") as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables every verb once the box has text", () => {
    render(<ReviewStrip {...props({
      expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true,
      bodies: { "CyberJackGit/aws-ops#8491": "the retry budget" },
    })} />);
    expect((screen.getByText("Request changes") as HTMLButtonElement).disabled).toBe(false);
  });

  it("reports typing and submitting", () => {
    const onBody = vi.fn();
    const onSubmit = vi.fn();
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true, onBody, onSubmit })} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "lgtm" } });
    expect(onBody).toHaveBeenCalledWith("CyberJackGit/aws-ops#8491", "lgtm");
    fireEvent.click(screen.getByText("Approve"));
    expect(onSubmit).toHaveBeenCalledWith("CyberJackGit/aws-ops#8491", "approve");
  });

  // Approve does not gate on body text (GitHub allows a bodiless approval) — only
  // `submitting` should touch it. Without this test, a broken `disabled={!body.trim()}`
  // left on Approve (copy-pasted from Comment/Request changes) would pass every test
  // above, since none of them submit Approve with an empty box.
  it("keeps approve enabled with an empty box", () => {
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true, bodies: {} })} />);
    expect((screen.getByText("Approve") as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables all three verbs while a submit is in flight for the row", () => {
    render(<ReviewStrip {...props({
      expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true,
      bodies: { "CyberJackGit/aws-ops#8491": "lgtm" },
      submitting: { "CyberJackGit/aws-ops#8491": true },
    })} />);
    expect((screen.getByText("Approve") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Comment") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Request changes") as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains why comment is disabled with an empty box", () => {
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true })} />);
    expect((screen.getByText("Comment") as HTMLButtonElement).title).toMatch(/add a message/i);
    expect((screen.getByText("Approve") as HTMLButtonElement).title).toBe("");
  });

  it("explains why every verb is disabled while a submit is in flight", () => {
    render(<ReviewStrip {...props({
      expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true,
      bodies: { "CyberJackGit/aws-ops#8491": "lgtm" },
      submitting: { "CyberJackGit/aws-ops#8491": true },
    })} />);
    expect((screen.getByText("Approve") as HTMLButtonElement).title).toMatch(/already in progress/i);
    expect((screen.getByText("Comment") as HTMLButtonElement).title).toMatch(/already in progress/i);
  });

  it("gives approve no title once the box has text and nothing is in flight", () => {
    render(<ReviewStrip {...props({
      expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true,
      bodies: { "CyberJackGit/aws-ops#8491": "lgtm" },
    })} />);
    expect((screen.getByText("Approve") as HTMLButtonElement).title).toBe("");
    expect((screen.getByText("Comment") as HTMLButtonElement).title).toBe("");
  });

  // Keyed by id: a submit in flight for a DIFFERENT row must not disable this one —
  // otherwise a single global "something is submitting" flag would pass the test
  // above just as well, and freeze every other row's buttons while one PR submits.
  it("does not disable a row's verbs for another row's in-flight submit", () => {
    render(<ReviewStrip {...props({
      expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true,
      bodies: { "CyberJackGit/aws-ops#8491": "lgtm" },
      submitting: { "someone/else#1": true },
    })} />);
    expect((screen.getByText("Approve") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows an inline warning after a failed submit, without the toast's own wording", () => {
    render(<ReviewStrip {...props({
      expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true,
      submitFailed: { "CyberJackGit/aws-ops#8491": true },
    })} />);
    expect(screen.getByText(/check the pr before trying again/i)).toBeInTheDocument();
    expect(screen.queryByText(/GitHub refused/i)).not.toBeInTheDocument();
  });

  it("shows no warning for a row that has not failed", () => {
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true })} />);
    expect(screen.queryByText(/check the pr before trying again/i)).not.toBeInTheDocument();
  });

  it("hides the failure warning entirely while writes are off", () => {
    render(<ReviewStrip {...props({
      expanded: "CyberJackGit/aws-ops#8491", reviewWrites: false,
      submitFailed: { "CyberJackGit/aws-ops#8491": true },
    })} />);
    expect(screen.queryByText(/check the pr before trying again/i)).not.toBeInTheDocument();
  });

  // The row's fields only stack into columns if each one is a single element with a
  // width. The +/− pair is the one that needed a wrapper — sized individually they
  // stayed ragged — and it has to keep both halves independently queryable, since
  // that is what proves the colours are still on the right numbers.
  it("wraps the additions and deletions in one diff column, both still their own element", () => {
    const { container } = render(<ReviewStrip {...props()} />);
    const diff = container.querySelector(".rv-diff")!;
    expect(diff).toBeInTheDocument();
    expect(diff.querySelector(".add")!.textContent).toBe("+350");
    expect(diff.querySelector(".del")!.textContent).toBe("−4");
  });

  it("keeps a truncatable repo and author recoverable through their titles", () => {
    const { container } = render(<ReviewStrip {...props()} />);
    expect(container.querySelector(".rv-repo")!.getAttribute("title")).toBe("aws-ops");
    expect(container.querySelector(".rv-author")!.getAttribute("title")).toBe("einavsaad");
  });

  describe("while the first search is running", () => {
    const loading = (over = {}) => props({ requests: [], issueCount: 0, loading: true, ...over });

    // The whole point of the pending state: at zero requests the strip normally
    // renders nothing at all, which is what left a cold start with no indication
    // that a queue was even coming.
    it("renders instead of collapsing to nothing", () => {
      render(<ReviewStrip {...loading()} />);
      expect(screen.getByText(/checking for PRs waiting on your review/i)).toBeInTheDocument();
    });

    // The skeleton rows stay as they are — they carry the shape of what is coming,
    // which the mark cannot. Only the ⟳ in the header gives way to it.
    it("marks the search with the animated logo, keeping the skeleton rows", () => {
      const { container } = render(<ReviewStrip {...loading()} />);
      expect(container.querySelector("svg.lmark")).toBeInTheDocument();
      expect(container.querySelector(".spin")).not.toBeInTheDocument();
      expect(container.querySelector(".sk")).toBeInTheDocument();
    });

    it("never claims a count it does not have", () => {
      render(<ReviewStrip {...loading()} />);
      expect(screen.queryByText(/0 PRs waiting/i)).not.toBeInTheDocument();
    });

    it("stands in three skeleton rows so the board settles once", () => {
      const { container } = render(<ReviewStrip {...loading()} />);
      expect(container.querySelectorAll(".rv-skel")).toHaveLength(3);
    });

    // A live sort control over placeholder rows invites a click that changes nothing.
    it("offers no sort control", () => {
      render(<ReviewStrip {...loading()} />);
      expect(screen.queryByText("oldest")).not.toBeInTheDocument();
      expect(screen.queryByText("smallest")).not.toBeInTheDocument();
    });

    it("keeps the header but drops the skeletons while collapsed", () => {
      const { container } = render(<ReviewStrip {...loading({ collapsed: true })} />);
      expect(screen.getByText(/checking for PRs waiting on your review/i)).toBeInTheDocument();
      expect(container.querySelectorAll(".rv-skel")).toHaveLength(0);
    });
  });

  // A first search that fails leaves the host with a null cache and `stale` set.
  // Shimmering forever would promise a result that is never coming, and the usual
  // "showing the last result" note would point at a result that never existed.
  describe("when the first search failed", () => {
    const failed = props({ requests: [], issueCount: 0, loading: false, stale: true });

    it("says it could not check, rather than counting zero", () => {
      render(<ReviewStrip {...failed} />);
      expect(screen.getByText(/couldn't check for PRs waiting on your review/i)).toBeInTheDocument();
      expect(screen.queryByText(/0 PRs waiting/i)).not.toBeInTheDocument();
    });

    it("shows no skeletons and no stale-result note", () => {
      const { container } = render(<ReviewStrip {...failed} />);
      expect(container.querySelectorAll(".rv-skel")).toHaveLength(0);
      expect(screen.queryByText(/showing the last result/i)).not.toBeInTheDocument();
    });

    it("still says it is showing the last result when there is one", () => {
      render(<ReviewStrip {...props({ stale: true })} />);
      expect(screen.getByText(/showing the last result/i)).toBeInTheDocument();
      expect(screen.getByText(/1 PR waiting on your review/i)).toBeInTheDocument();
    });
  });
});
