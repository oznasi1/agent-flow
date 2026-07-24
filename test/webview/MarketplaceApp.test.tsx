// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { MarketplaceApp } from "../../src/webview/MarketplaceApp";
import { send } from "../../src/webview/vscodeApi";
import type { OutboundMessage, MarketplaceView } from "../../src/types";

const sent = vi.mocked(send);
function host(msg: OutboundMessage) {
  act(() => { window.dispatchEvent(new MessageEvent("message", { data: msg })); });
}
const mkView = (over: Partial<MarketplaceView> = {}): MarketplaceView => ({
  repo: "o/r", name: "atbay-plugins", description: "At-Bay plugins", owner: "At-Bay",
  addCommand: "/plugin marketplace add o/r",
  plugins: [{
    name: "cicd-plugin", description: "CI/CD automation", source: "plugins/cicd-plugin",
    skills: [{ name: "build", path: "plugins/cicd-plugin/skills/build/SKILL.md" }],
    agents: [{ name: "pipeline-agent", path: "plugins/cicd-plugin/agents/pipeline-agent.md" }],
    commands: [{ name: "deploy", path: "plugins/cicd-plugin/commands/deploy.md" }],
    installCommand: "/plugin install cicd-plugin@atbay-plugins",
  }],
  ...over,
});
const stateMsg = (marketplaces: MarketplaceView[]): OutboundMessage => ({ type: "mkt:state", marketplaces });

beforeEach(() => sent.mockClear());

describe("MarketplaceApp", () => {
  it("announces readiness on mount", () => {
    render(<MarketplaceApp />);
    expect(sent).toHaveBeenCalledWith({ type: "mkt:ready" });
  });

  it("shows the empty state with no marketplaces", () => {
    render(<MarketplaceApp />);
    host(stateMsg([]));
    expect(screen.getByText(/No marketplaces yet/i)).toBeInTheDocument();
  });

  it("renders a marketplace card with its plugin and item chips", () => {
    render(<MarketplaceApp />);
    host(stateMsg([mkView()]));
    expect(screen.getByText("atbay-plugins")).toBeInTheDocument();
    expect(screen.getByText("cicd-plugin")).toBeInTheDocument();
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByText("pipeline-agent")).toBeInTheDocument();
    expect(screen.getByText("deploy")).toBeInTheDocument();
  });

  it("sends mkt:add when a repo is typed and Add is clicked", () => {
    render(<MarketplaceApp />);
    fireEvent.change(screen.getByPlaceholderText(/owner\/repo/i), { target: { value: "new/repo" } });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:add", repo: "new/repo" });
  });

  it("sends mkt:remove when the card's × is clicked", () => {
    render(<MarketplaceApp />);
    host(stateMsg([mkView()]));
    fireEvent.click(screen.getByTitle(/remove/i));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:remove", repo: "o/r" });
  });

  it("sends mkt:copy with the install snippet when Copy is clicked", () => {
    render(<MarketplaceApp />);
    host(stateMsg([mkView()]));
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(sent).toHaveBeenCalledWith({
      type: "mkt:copy",
      text: "/plugin marketplace add o/r\n/plugin install cicd-plugin@atbay-plugins",
    });
  });

  it("sends mkt:refresh when Refresh is clicked", () => {
    render(<MarketplaceApp />);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:refresh" });
  });

  it("renders a scoped error message on a card", () => {
    render(<MarketplaceApp />);
    host(stateMsg([mkView({ plugins: [], error: { kind: "repo-not-found", message: "Repo not found, or you don't have access." } })]));
    expect(screen.getByText(/Repo not found/i)).toBeInTheDocument();
  });
});
