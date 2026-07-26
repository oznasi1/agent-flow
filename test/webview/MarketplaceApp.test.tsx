// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { MarketplaceApp } from "../../src/webview/MarketplaceApp";
import { send } from "../../src/webview/vscodeApi";
import type { AssetView, ClaudeAssetsView, OutboundMessage, PluginRowView } from "../../src/types";

const sent = vi.mocked(send);
function host(msg: OutboundMessage) {
  act(() => { window.dispatchEvent(new MessageEvent("message", { data: msg })); });
}

const asset = (over: Partial<AssetView> = {}): AssetView => ({
  type: "skill", name: "build", description: "Builds the thing", plugin: "cicd-plugin",
  marketplace: "atbay", file: "/a/skills/build/SKILL.md", rel: "skills/build/SKILL.md",
  enabled: true, state: "installed", category: "deployment", ...over,
});
const plugin = (over: Partial<PluginRowView> = {}): PluginRowView => ({
  name: "remote-one", marketplace: "atbay", description: "Lives elsewhere", state: "manifest",
  enabled: null, scopes: [], version: "", counts: { skill: 0, command: 0, agent: 0, hook: 0 },
  category: "deployment", readme: "", installCommand: "/plugin install remote-one@atbay", ...over,
});
const view = (over: Partial<ClaudeAssetsView> = {}): ClaudeAssetsView => ({
  marketplaces: [{ name: "atbay", kind: "github", origin: "org/atbay", pluginCount: 2, stale: false }],
  plugins: [plugin()],
  assets: [
    asset(),
    asset({ type: "command", name: "deploy", description: "Ships it", file: "/a/commands/deploy.md", rel: "commands/deploy.md" }),
    asset({ type: "agent", name: "pipeline", description: "Runs CI", file: "/a/agents/pipeline.md", rel: "agents/pipeline.md" }),
    asset({ type: "hook", name: "SessionStart", description: "node hook.js", file: "/a/hooks/hooks.json", rel: "hooks/hooks.json" }),
    asset({ name: "watch", description: "Watches things", plugin: "gc-plugin", category: "monitoring", file: "/b/skills/watch/SKILL.md" }),
    asset({ name: "mine", description: "My own skill", plugin: "(user)", marketplace: "~/.claude", category: "yours", state: "user", file: "/u/skills/mine/SKILL.md" }),
  ],
  notSetUp: false,
  scannedAt: 1,
  ...over,
});
const assetsMsg = (v: ClaudeAssetsView = view()): OutboundMessage => ({ type: "mkt:assets", view: v });

beforeEach(() => sent.mockClear());

// The detail pane repeats the selected row's name, so any name that is BOTH listed
// and selected appears twice. Assert with getAllByText for those, never getByText.
const rowText = (t: string) => screen.getAllByText(t)[0];

describe("MarketplaceApp", () => {
  it("announces readiness on mount", () => {
    render(<MarketplaceApp />);
    expect(sent).toHaveBeenCalledWith({ type: "mkt:ready" });
  });

  it("lists every asset with its description", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    expect(screen.getAllByText("build").length).toBeGreaterThan(0);
    expect(screen.getByText("/deploy")).toBeInTheDocument();
    expect(screen.getByText("pipeline")).toBeInTheDocument();
    expect(screen.getByText("SessionStart")).toBeInTheDocument();
    expect(screen.getAllByText(/Builds the thing/).length).toBeGreaterThan(0);
  });

  it("filters by the search box", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "deploy" } });
    expect(screen.getAllByText("/deploy").length).toBeGreaterThan(0);
    expect(screen.queryByText("pipeline")).not.toBeInTheDocument();
  });

  it("filters to one type via its pill", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /^Agents/i }));
    expect(screen.getAllByText("pipeline").length).toBeGreaterThan(0);
    expect(screen.queryByText("build")).not.toBeInTheDocument();
  });

  // Regression: several hooks can share an event, matcher and file, which used to
  // give them the same React key. Duplicate keys orphan the DOM nodes, so those
  // rows survived every later filter change and showed up under Skills.
  it("drops hooks under another type pill even when several share an event and file", () => {
    const twin = (description: string) =>
      asset({ type: "hook", name: "PostToolUse", description, file: "/a/hooks/hooks.json", rel: "hooks/hooks.json (Bash)" });
    render(<MarketplaceApp />);
    // A surviving row after the twins matters: it forces React down the keyed-map
    // reconciliation path, which is where duplicate keys orphan a node.
    host(assetsMsg(view({
      assets: [asset(), twin("commit.sh"), twin("push.sh"), twin("create.sh"), asset({ name: "later", file: "/z" })],
    })));
    expect(document.querySelectorAll(".row.t-hook")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /^Skills/i }));
    expect(document.querySelectorAll(".row.t-hook")).toHaveLength(0);
    expect(screen.queryByText("PostToolUse")).not.toBeInTheDocument();
  });

  // Grouping is by category now, not type — so the interleaving that matters is
  // across categories, not asset types. Two categories, evenly split, tie-break
  // alphabetically: "deployment" sorts before "monitoring".
  it("heads each category section once, however the scan interleaves them", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(view({
      assets: [
        asset({ name: "a-skill", category: "monitoring" }),
        asset({ type: "hook", name: "Stop", file: "/1", rel: "1", category: "deployment" }),
        asset({ name: "b-skill", file: "/2", category: "monitoring" }),
        asset({ type: "hook", name: "SessionEnd", file: "/3", rel: "3", category: "deployment" }),
      ],
    })));
    const heads = [...document.querySelectorAll(".grouphd .lb")].map((e) => e.textContent);
    expect(heads).toEqual([...new Set(heads)]);
    expect(heads).toEqual(["Deployment", "Monitoring"]);
  });

  it("matches a fuzzy subsequence rather than only substrings", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "ppln" } });
    expect(screen.getAllByText("pipeline").length).toBeGreaterThan(0);
    expect(screen.queryByText("/deploy")).not.toBeInTheDocument();
  });

  it("ranks a name hit above a description-only hit", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(view({
      assets: [
        asset({ name: "unrelated", description: "handles deploy paperwork", file: "/1" }),
        asset({ name: "deploy", description: "nothing to see", file: "/2" }),
      ],
    })));
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "deploy" } });
    expect(document.querySelector(".row .nm")?.textContent).toBe("deploy");
  });

  it("matches prose literally, so a subsequence of a blurb is not a hit", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(view({ assets: [asset({ name: "aaa", description: "Builds the thing" })] })));
    // "bldt" threads through "Builds the thing" as a subsequence; matching prose
    // that loosely would return nearly the whole list on any short query.
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "bldt" } });
    expect(screen.getByText(/nothing matches/i)).toBeInTheDocument();
  });

  it("narrows, not widens, when a second term is typed", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(view({
      assets: [
        asset({ name: "deploy-web", description: "Ships the site", file: "/1" }),
        asset({ name: "deploy-api", description: "Ships the service", file: "/2" }),
      ],
    })));
    const box = screen.getByPlaceholderText(/search/i);
    fireEvent.change(box, { target: { value: "deploy" } });
    expect(document.querySelectorAll(".results > .row")).toHaveLength(2);
    fireEvent.change(box, { target: { value: "deploy site" } });
    expect(document.querySelectorAll(".results > .row")).toHaveLength(1);
    expect(document.querySelector(".row .nm")?.textContent).toBe("deploy-web");
  });

  it("retallies the type pills against the query", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "deploy" } });
    expect(screen.getByRole("button", { name: /^Commands/i }).textContent).toBe("Commands1");
    expect(screen.getByRole("button", { name: /^Skills/i }).textContent).toBe("Skills0");
  });

  it("shows plugin rows under the Plugins pill, including not-downloaded ones", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /^Plugins/i }));
    expect(screen.getAllByText("remote-one").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/not downloaded/i).length).toBeGreaterThan(0);
  });

  it("sends mkt:open when Open file is clicked", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    // Rows sort Yours-first, so "mine" is the default selection, not "build".
    fireEvent.click(screen.getByRole("button", { name: /open file/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:open", file: "/u/skills/mine/SKILL.md" });
  });

  it("sends mkt:reveal when Reveal is clicked", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:reveal", file: "/u/skills/mine/SKILL.md" });
  });

  it("copies a command as /name and a skill as its bare name", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:copy", text: "mine" });
    sent.mockClear();
    fireEvent.click(screen.getByText("/deploy"));
    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:copy", text: "/deploy" });
  });

  it("copies the install command for a plugin row", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /^Plugins/i }));
    fireEvent.click(rowText("remote-one")); // the list row, not the detail heading
    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:copy", text: "/plugin install remote-one@atbay" });
  });

  it("moves the selection with the arrow keys", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    const box = screen.getByPlaceholderText(/search/i);
    // Yours-first ordering puts "mine" at index 0 and "build" at index 1.
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: /open file/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:open", file: "/a/skills/build/SKILL.md" });
  });

  it("restricts to installed assets via the scope pill", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(view({ assets: [asset(), asset({ name: "listed", state: "manifest", file: "/b.md" })] })));
    fireEvent.click(screen.getByRole("button", { name: /installed only/i }));
    expect(screen.getAllByText("build").length).toBeGreaterThan(0);
    expect(screen.queryByText("listed")).not.toBeInTheDocument();
  });

  it("hides explicitly disabled assets under Enabled only", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(view({ assets: [asset(), asset({ name: "off-one", enabled: false, file: "/c.md" })] })));
    fireEvent.click(screen.getByRole("button", { name: /enabled only/i }));
    expect(screen.queryByText("off-one")).not.toBeInTheDocument();
  });

  it("marks a disabled asset in the list", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(view({ assets: [asset({ enabled: false })] })));
    expect(screen.getAllByText(/disabled/i).length).toBeGreaterThan(0);
  });

  it("shows the not-set-up state", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(view({ notSetUp: true, assets: [], plugins: [], marketplaces: [] })));
    expect(screen.getByText(/isn't set up on this machine/i)).toBeInTheDocument();
  });

  it("shows a no-match state for a query that matches nothing", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "zzzz" } });
    expect(screen.getByText(/nothing matches/i)).toBeInTheDocument();
  });

  it("flags a stale marketplace", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(view({ marketplaces: [{ name: "ghost", kind: "directory", origin: "/gone", pluginCount: 0, stale: true }] })));
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
  });

  it("sends mkt:refresh when Rescan is clicked", () => {
    render(<MarketplaceApp />);
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:refresh" });
  });

  it("copies the marketplace-add hint", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /add a marketplace/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:copy", text: "/plugin marketplace add owner/repo" });
  });

  it("renders a toast from the host", () => {
    render(<MarketplaceApp />);
    host({ type: "toast", level: "success", message: "Copied to clipboard." });
    expect(screen.getByText("Copied to clipboard.")).toBeInTheDocument();
  });

  it("shows a loading line while the host scans", () => {
    render(<MarketplaceApp />);
    host({ type: "mkt:loading", loading: true });
    expect(screen.getByText(/scanning/i)).toBeInTheDocument();
  });
});

describe("MarketplaceApp category sections", () => {
  const headings = () => screen.getAllByRole("button", { name: /^(Yours|Development|Monitoring|Deployment|Uncategorized)\b/ })
    .map((b) => b.textContent!.replace(/\d+$/, "").trim());

  it("groups the browse list by category, Yours first", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    expect(headings()).toEqual(["Yours", "Deployment", "Monitoring"]);
  });

  it("counts the rows in each section header", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    expect(screen.getByRole("button", { name: /^Deployment/ }).textContent).toContain("4");
    expect(screen.getByRole("button", { name: /^Monitoring/ }).textContent).toContain("1");
  });

  it("sections the Skills tab too, not only All", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /^Skills/ }));
    expect(headings()).toEqual(["Yours", "Deployment", "Monitoring"]);
  });

  it("shows no headers while searching, because the list is ranked", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "watch" } });
    expect(screen.queryByRole("button", { name: /^Monitoring/ })).not.toBeInTheDocument();
  });

  it("focuses a category when its header is clicked, and drops the other sections", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /^Monitoring/ }));
    expect(rowText("watch")).toBeInTheDocument();
    expect(screen.queryByText("pipeline")).not.toBeInTheDocument();
    // Not a name match on "Monitoring": the chip's own label starts with the same
    // word, so that query would also catch the chip. ".grouphd" is unambiguous.
    expect(document.querySelectorAll(".grouphd")).toHaveLength(0);
  });

  it("clears the focus from its chip", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /^Monitoring/ }));
    fireEvent.click(screen.getByRole("button", { name: /Monitoring ×/ }));
    expect(screen.getAllByText("pipeline").length).toBeGreaterThan(0);
  });

  it("hides the chip row entirely when nothing is selected", () => {
    const { container } = render(<MarketplaceApp />);
    host(assetsMsg());
    expect(container.querySelector(".chips")).toBeNull();
  });

  it("keeps the type pill counts honest while a category is focused", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /^Monitoring/ }));
    expect(screen.getByRole("button", { name: /^Skills/ }).textContent).toContain("1");
  });
});
