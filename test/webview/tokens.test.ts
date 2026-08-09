import { describe, it, expect } from "vitest";
import { TOKENS_CSS, BASE_CSS, CONTROLS_CSS } from "../../src/webview/tokens";
import { CSS } from "../../src/webview/styles";
import { DECK_CSS } from "../../src/webview/deckStyles";
import { MARKETPLACE_CSS } from "../../src/webview/marketplaceStyles";
import { ORCH_CSS } from "../../src/webview/orchestratorStyles";

/** The tokens tokens.ts owns. A surface may USE these; none may DECLARE them. */
const OWNED = [
  "--t-micro", "--t-data", "--t-body", "--t-title",
  "--r-card", "--r-ctl", "--r-chip",
  "--c-progress", "--c-attn", "--c-review", "--c-done", "--c-idle", "--c-danger",
  "--k-skill", "--k-command", "--k-agent", "--k-hook", "--k-plugin",
  "--hair", "--edge", "--mono", "--dim",
  "--brand", "--brand-ink",
];

const SURFACES: [string, string][] = [
  ["sidebar", CSS],
  ["deck", DECK_CSS],
  ["marketplace", MARKETPLACE_CSS],
  ["controls", CONTROLS_CSS],
  ["orchestrator", ORCH_CSS],
];

// Comments are prose, not CSS: deckStyles.ts has one that reads "...--c-attn, not
// --c-danger: nothing here is broken..." — a naive scan of the raw sheet text would
// misread that colon as a declaration. Strip comments first so only real rules count.
const stripComments = (sheet: string): string => sheet.replace(/\/\*[\s\S]*?\*\//g, "");

// @keyframes bodies nest a brace inside a brace (each one is written on a single
// line in these sheets), which would break the flat selector/body parser below.
// None of them ever reference --brand or font-size, so dropping the whole line
// is safe for every scan that uses it.
const stripKeyframes = (sheet: string): string => sheet.replace(/^.*@keyframes.*$/gm, "");

const declarationsIn = (sheet: string): string[] =>
  [...stripComments(sheet).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);

const usagesIn = (sheet: string): string[] =>
  [...stripComments(sheet).matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]);

/** Every flat `selector { declarations }` block in a sheet. */
const ruleBlocks = (sheet: string): { selector: string; body: string }[] =>
  [...stripKeyframes(stripComments(sheet)).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim().replace(/\s+/g, " "),
    body: m[2],
  }));

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

describe("brand accent", () => {
  it("declares the dark default and the light override", () => {
    expect(TOKENS_CSS).toContain("--brand: #2AA79B");
    expect(TOKENS_CSS).toContain("--brand-ink: #04211E");
    expect(TOKENS_CSS).toMatch(/body\.vscode-light\s*{[^}]*--brand:\s*#157F76/);
    expect(TOKENS_CSS).toMatch(/body\.vscode-light\s*{[^}]*--brand-ink:\s*#ffffff/);
  });

  // Regression guard. currentColor in any property other than `color` resolves to
  // that element's own color, so `background: var(--brand)` on a filled button
  // would equal its label color and the text would disappear. This nearly shipped.
  // Comments are stripped first so a comment merely discussing the keyword (as
  // tokens.ts's own high-contrast note does) can't trip this scan.
  it("never resolves the accent to currentColor", () => {
    expect(stripComments(TOKENS_CSS)).not.toContain("currentColor");
  });

  // The board's rule: one card at a time gets to be loud, and the loud one is
  // orange. A teal button inside the attention card would be a second claim on
  // the same attention.
  it("never reaches a .attn selector on the Deck", () => {
    const attnBlocks = [...DECK_CSS.matchAll(/([^}]*\.attn[^{]*){([^}]*)}/g)].map((m) => m[2]);
    expect(attnBlocks.length).toBeGreaterThan(0);
    expect(attnBlocks.filter((b) => b.includes("--brand"))).toEqual([]);
  });

  // A "does this sheet mention --brand at all" check would pass with the accent on
  // twenty selectors. This asserts the exact selector list per surface — derived
  // from what actually ships (the plan's own three-place prose went stale the
  // moment .btn.pri and the final-review's .batch-launch / .gate .btn landed).
  const PERMITTED_BRAND_SELECTORS: Record<string, string[]> = {
    sidebar: [
      ".gauge .lit",
      ".take", ".take:hover",
      ".gate .btn", ".gate .btn:hover",
      ".batch-launch", ".batch-launch:hover",
      // Notepad restyle (direction B): the checkbox tint is the one new place
      // the sidebar spends the brand hue.
      ".cb",
    ],
    // `.ctl.on .switch` is gone from this list because the rule itself is gone:
    // the header redesign moved the trust toggles into settings, and `.switch`
    // no longer appears in deckStyles.ts at all. (It had already lost its
    // `::after` sibling here, which the tightened detector showed spends only
    // `var(--brand-ink)`, never `var(--brand)`.)
    deck: [".act.primary", ".act.primary:hover"],
    marketplace: [".btn.pri", ".btn.pri:hover"],
    controls: [],
    orchestrator: [
      ".orch-tray.over", ".orch-node.sel", ".orch-graph.over",
      ".orch-port:hover",
      ".orch-graph.wiring .orch-node:not(.src)",
      ".orch-graph.wiring .orch-node:not(.src) .orch-port.in",
      ".orch-edge.sel",
      ".orch-arm", ".orch-arm.on",
      ".orch-ft .live.on .d",
    ],
  };

  // A plain `body.includes("--brand")` also lights up on `--brand-ink`, since
  // "--brand-ink".includes("--brand") is true — a selector whose only var() is
  // `var(--brand-ink)` (ink, not fill) would be wrongly counted as spending the
  // fill token. Extract each var()'s real token name the same way `usagesIn`
  // does, and compare it exactly, so `--brand-ink` cannot stand in for `--brand`.
  const spendsBrandFill = (body: string): boolean =>
    [...body.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].some((m) => m[1] === "--brand");

  it.each(SURFACES)("%s spends --brand on exactly its agreed selectors", (name, sheet) => {
    const actual = new Set(
      ruleBlocks(sheet).filter((r) => spendsBrandFill(r.body)).map((r) => r.selector),
    );
    const allowed = new Set(PERMITTED_BRAND_SELECTORS[name] ?? []);
    // Each string below names the offending selector directly, so a failure reads
    // as actionable rather than just a red boolean.
    const problems = [
      ...[...actual].filter((s) => !allowed.has(s)).map((s) => `unexpected --brand on "${s}"`),
      ...[...allowed].filter((s) => !actual.has(s)).map((s) => `"${s}" no longer spends --brand`),
    ];
    expect(problems).toEqual([]);
  });
});

describe("no raw hex colour", () => {
  // tokens.ts (TOKENS_CSS) owns the brand triplet's literal hexes and every
  // --c-*/--k-* fallback; it is the token module, not a surface, and isn't part
  // of SURFACES, so it is deliberately not scanned here. A surface sheet should
  // only ever reach a colour through a token or a --vscode-* variable — the
  // exact drift the token module exists to prevent.
  it.each(SURFACES)("%s carries no hardcoded hex", (_name, sheet) => {
    const hexes = [...stripComments(sheet).matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(hexes).toEqual([]);
  });
});

describe("type scale", () => {
  // Global Constraints closes the type scale for styles.ts (the sidebar) and, by
  // construction, CONTROLS_CSS (new, and already 100% on-token). Deck and
  // Marketplace carry a much larger set of literals that predate the token
  // module entirely and that no task in this plan touches — migrating the
  // Deck's own control language and closing the sidebar's remaining literals are
  // both explicitly out of scope (see the plan). Scanning those two sheets here
  // would fail on legacy code, not on new drift.
  const SCALE_CLOSED: [string, string][] = [["sidebar", CSS], ["controls", CONTROLS_CSS]];

  // The four token steps' own values, plus the 15px surface header Global
  // Constraints also names, plus the six off-scale literals that section
  // grandfathers into styles.ts specifically (8, 9, 11.5, 12, 12.5, 14 — styles.ts
  // predates the token module, and converting untouched rules is its own
  // follow-up, not this guard's job). Anything outside this set is new drift.
  const ON_SCALE_LITERALS = [
    "8px", "9px", "10px", "10.5px", "11px", "11.5px", "12px", "12.5px", "13px", "14px", "15px",
  ];

  const fontSizeValuesIn = (sheet: string): string[] =>
    [...stripKeyframes(stripComments(sheet)).matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim());

  it.each(SCALE_CLOSED)("%s: every font-size is a token or an allowlisted legacy literal", (_name, sheet) => {
    const offenders = fontSizeValuesIn(sheet).filter(
      (v) => !v.startsWith("var(--t-") && !v.startsWith("var(--vscode-") && !ON_SCALE_LITERALS.includes(v),
    );
    expect(offenders).toEqual([]);
  });
});

describe("surface header", () => {
  // The Deck's gloss sits on its own line under "In-flight". It is a block for that
  // reason alone, so the obvious "tidy-up" — folding it back to an inline span with a
  // margin, the way it used to read — is a regression, not a simplification. Asserting
  // the absence of margin-left too: with display:block the margin is dead weight that
  // would silently indent the second line if anyone restored it.
  it("stacks the Deck's gloss under the title rather than beside it", () => {
    const sub = ruleBlocks(DECK_CSS).find((r) => r.selector === ".hd .title .sub");
    expect(sub).toBeDefined();
    expect(sub!.body).toMatch(/display:\s*block/);
    expect(sub!.body).not.toMatch(/margin-left/);
  });
});

describe("CONTROLS_CSS", () => {
  it("defines the segmented control and declares no tokens of its own", () => {
    expect(CONTROLS_CSS).toContain(".seg");
    expect(declarationsIn(CONTROLS_CSS)).toEqual([]);
  });

  it("marks the on-state with weight and foreground, never a fill", () => {
    const on = CONTROLS_CSS.match(/\.seg > button\[aria-pressed="true"\]\s*{([^}]*)}/);
    expect(on).not.toBeNull();
    expect(on![1]).not.toContain("--vscode-button-background");
    // The on-state may tint with the foreground via color-mix; it must never take a
    // theme fill token directly. Asserting the absence of one specific variable let
    // any other fill token through.
    expect(on![1]).not.toMatch(/background:\s*var\(--vscode-/);
  });
});

describe("notepad fields", () => {
  // The panel has one focus language: suppress the UA outline, move focus onto the
  // control's own border (see .text-search:focus-within). The notepad's two fields
  // were the only ones that skipped it and fell through to the global :focus-visible
  // rule in tokens.ts — a detached halo, 2px off the field, at the wrong radius.
  it("focus on the field's own border, not the global outline", () => {
    const focus = ruleBlocks(CSS).find((r) => r.selector === ".np-title-input:focus, .np-body-input:focus");
    expect(focus).toBeDefined();
    expect(focus!.body).toMatch(/outline:\s*none/);
    expect(focus!.body).toMatch(/border-color:\s*var\(--vscode-focusBorder\)/);
  });

  // Load-bearing: without a resting border the focused one materializes out of
  // nothing, which reads as the field jumping rather than lighting up.
  it("carry a resting border for that focus border to replace", () => {
    const rest = ruleBlocks(CSS).find((r) => r.selector === ".np-title-input, .np-body-input");
    expect(rest).toBeDefined();
    expect(rest!.body).not.toMatch(/border:\s*1px solid var\(--vscode-input-border,\s*transparent\)/);
    expect(rest!.body).toMatch(/border:\s*1px solid var\(--vscode-input-border,\s*var\(--hair\)\)/);
  });
});
