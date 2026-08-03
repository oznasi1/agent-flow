import { describe, it, expect } from "vitest";
import { TOKENS_CSS, BASE_CSS } from "../../src/webview/tokens";
import { CSS } from "../../src/webview/styles";
import { DECK_CSS } from "../../src/webview/deckStyles";
import { MARKETPLACE_CSS } from "../../src/webview/marketplaceStyles";

/** The tokens tokens.ts owns. A surface may USE these; none may DECLARE them. */
const OWNED = [
  "--t-micro", "--t-data", "--t-body", "--t-title",
  "--r-card", "--r-ctl", "--r-chip",
  "--c-progress", "--c-attn", "--c-review", "--c-done", "--c-idle", "--c-danger",
  "--k-skill", "--k-command", "--k-agent", "--k-hook", "--k-plugin",
  "--hair", "--edge", "--mono", "--dim",
];

const SURFACES: [string, string][] = [
  ["sidebar", CSS],
  ["deck", DECK_CSS],
  ["marketplace", MARKETPLACE_CSS],
];

// Comments are prose, not CSS: deckStyles.ts has one that reads "...--c-attn, not
// --c-danger: nothing here is broken..." — a naive scan of the raw sheet text would
// misread that colon as a declaration. Strip comments first so only real rules count.
const stripComments = (sheet: string): string => sheet.replace(/\/\*[\s\S]*?\*\//g, "");

const declarationsIn = (sheet: string): string[] =>
  [...stripComments(sheet).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);

const usagesIn = (sheet: string): string[] =>
  [...stripComments(sheet).matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]);

// Set per-card as an inline style in DeckApp.tsx (a computed value, not a shared
// token), so it never appears as a declaration in any stylesheet's own text —
// excluded from the orphan check the same way --vscode-* variables are.
const RUNTIME_ONLY = ["--accent"];

describe("tokens.ts", () => {
  it("declares every token it owns", () => {
    const declared = new Set(declarationsIn(TOKENS_CSS));
    expect(OWNED.filter((t) => !declared.has(t))).toEqual([]);
  });

  it("carries the shared reset, not the tokens", () => {
    expect(BASE_CSS).toContain("box-sizing");
    expect(BASE_CSS).toContain("prefers-reduced-motion");
    expect(declarationsIn(BASE_CSS)).toEqual([]);
  });
});

describe.each(SURFACES)("%s sheet", (_name, sheet) => {
  it("never redeclares a token tokens.ts owns", () => {
    const clashes = declarationsIn(sheet).filter((t) => OWNED.includes(t));
    expect(clashes).toEqual([]);
  });

  it("only uses custom properties that are declared somewhere", () => {
    const local = new Set(declarationsIn(sheet));
    const orphans = [...new Set(usagesIn(sheet))].filter(
      (t) =>
        !t.startsWith("--vscode-") &&
        !OWNED.includes(t) &&
        !RUNTIME_ONLY.includes(t) &&
        !local.has(t),
    );
    expect(orphans).toEqual([]);
  });

  it("carries no reset of its own", () => {
    expect(sheet).not.toContain("box-sizing");
    expect(sheet).not.toContain("prefers-reduced-motion");
  });
});
