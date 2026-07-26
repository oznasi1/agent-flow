// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { PluginPicker, PickerItem } from "../../src/webview/PluginPicker";

const items: PickerItem[] = [
  { key: "superpowers@official", name: "superpowers", marketplace: "official", count: 17 },
  { key: "cicd-plugin@atbay", name: "cicd-plugin", marketplace: "atbay", count: 5 },
  { key: "figma@official", name: "figma", marketplace: "official", count: 0 },
];
const setup = (selected: string[] = []) => {
  const onToggle = vi.fn();
  const onClear = vi.fn();
  render(<PluginPicker items={items} selected={selected} onToggle={onToggle} onClear={onClear} />);
  return { onToggle, onClear };
};

describe("PluginPicker", () => {
  it("stays closed until the button is pressed", () => {
    setup();
    expect(screen.queryByPlaceholderText(/filter plugins/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Plugins/ }));
    expect(screen.getByPlaceholderText(/filter plugins/i)).toBeInTheDocument();
  });

  it("shows the selected count on the button and nothing when empty", () => {
    setup(["cicd-plugin@atbay"]);
    expect(screen.getByRole("button", { name: /^Plugins/ }).textContent).toContain("1");
  });

  it("lists every item with its asset count", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /^Plugins/ }));
    // getByLabelText returns the checkbox, whose own textContent is empty — read
    // the enclosing label for the row's text.
    expect(screen.getByText("superpowers").closest("label")!.textContent).toContain("17");
    expect(screen.getByLabelText("figma")).toBeInTheDocument();
  });

  it("narrows the list as you type", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /^Plugins/ }));
    fireEvent.change(screen.getByPlaceholderText(/filter plugins/i), { target: { value: "cicd" } });
    expect(screen.getByLabelText("cicd-plugin")).toBeInTheDocument();
    expect(screen.queryByLabelText("superpowers")).not.toBeInTheDocument();
  });

  it("reports a toggle with the item's key", () => {
    const { onToggle } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^Plugins/ }));
    fireEvent.click(screen.getByLabelText("superpowers"));
    expect(onToggle).toHaveBeenCalledWith("superpowers@official");
  });

  it("shows a checked box for a selected item", () => {
    setup(["superpowers@official"]);
    fireEvent.click(screen.getByRole("button", { name: /^Plugins/ }));
    expect(screen.getByLabelText("superpowers")).toBeChecked();
  });

  it("disambiguates two plugins that share a name", () => {
    render(
      <PluginPicker
        items={[
          { key: "build@a", name: "build", marketplace: "a", count: 1 },
          { key: "build@b", name: "build", marketplace: "b", count: 1 },
        ]}
        selected={[]}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Plugins/ }));
    expect(screen.getAllByText("build")).toHaveLength(2);
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
  });

  it("offers a clear action only when something is selected", () => {
    const { onClear } = setup(["superpowers@official"]);
    fireEvent.click(screen.getByRole("button", { name: /^Plugins/ }));
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(onClear).toHaveBeenCalled();
  });

  it("closes when the button is pressed again", () => {
    setup();
    const btn = screen.getByRole("button", { name: /^Plugins/ });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(screen.queryByPlaceholderText(/filter plugins/i)).not.toBeInTheDocument();
  });
});
