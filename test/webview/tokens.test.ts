import { describe, it, expect } from "vitest";
import { TOKENS_CSS, BASE_CSS, CONTROLS_CSS } from "../../src/webview/tokens";
import { CSS } from "../../src/webview/styles";
import { DECK_CSS } from "../../src/webview/deckStyles";
import { MARKETPLACE_CSS } from "../../src/webview/marketplaceStyles";
import { ORCH_CSS } from "../../src/webview/orchestratorStyles";
import { CYCLE_MS } from "../../src/webview/markGeometry";

/** The tokens tokens.ts owns. A surface may USE these; none may DECLARE them. */
const OWNED = [
  "--t-micro", "--t-data", "--t-body", "--t-title",
  "--r-card", "--r-ctl", "--r-chip",
  "--c-progress", "--c-attn", "--c-review", "--c-done", "--c-idle", "--c-danger",
  "--k-skill", "--k-command", "--k-agent", "--k-hook", "--k-plugin",
  "--k-story", "--k-epic", "--k-task", "--k-subtask", "--k-bug", "--k-other",
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

// Set as inline styles in DeckApp.tsx (computed values, not shared tokens), so
// they never appear as a declaration in any stylesheet's own text — excluded from
// the orphan check the same way --vscode-* variables are. `--accent` is per-card;
// `--zone` is per-board-column, and carries that zone's hue to every rule under it.
const RUNTIME_ONLY = ["--accent", "--zone"];

describe("tokens.ts", () => {
  it("declares every token it owns", () => {
    const declared = new Set(declarationsIn(TOKENS_CSS));
    expect(OWNED.filter((t) => !declared.has(t))).toEqual([]);
  });

  // BASE_CSS turns every animation off under prefers-reduced-motion, which freezes
  // the loader on whatever its unanimated rule says. The comet's dim phase is nearly
  // invisible, so the rule has to rest LIT and let the keyframes dim from there —
  // otherwise reduced-motion users get a blank hole where the mark should be.
  it("rests the loading mark lit, so reduced motion leaves a visible mark", () => {
    const rule = ruleBlocks(BASE_CSS).find((r) => r.selector === ".lmark .ldot");
    expect(rule).toBeDefined();
    // The dots move because of this one declaration — the per-dot delays only decide
    // WHICH dot is lit when. Drop it and every loader in the product silently becomes
    // a static logo, with nothing else in the suite noticing. The duration is matched
    // against markGeometry's constant because that is the pairing the stagger assumes.
    expect(rule!.body).toMatch(new RegExp(`animation:\\s*mark-comet\\s+${CYCLE_MS}ms`));
    const opacity = Number(/opacity:\s*([\d.]+)/.exec(rule!.body)?.[1]);
    const frames = /@keyframes mark-comet[^\n]*/.exec(BASE_CSS)![0];
    const dimmest = Math.min(
      ...[...frames.matchAll(/opacity:\s*([\d.]+)/g)].map((m) => Number(m[1])),
    );
    expect(opacity).toBeGreaterThan(dimmest);
    expect(opacity).toBeGreaterThanOrEqual(0.8);
  });

  it("carries the shared reset, not the tokens", () => {
    expect(BASE_CSS).toContain("box-sizing");
    expect(BASE_CSS).toContain("prefers-reduced-motion");
    expect(declarationsIn(BASE_CSS)).toEqual([]);
  });
});

describe.each(SURFACES)("%s sheet", (_name, sheet) => {
  // These sheets are template literals full of long prose comments, and a stray
  // `*/` in one is invisible: TypeScript compiles it, the bundle builds, and the
  // browser silently discards the prose AND the rule that follows it, because
  // together they read as one invalid selector. It has happened three times in
  // this file's lifetime; the last one shipped a "Saved in settings as…" line at
  // the wrong size and the wrong indent, found by eye in a screenshot.
  //
  // Walking the delimiters is what catches it: outside a comment, `*/` cannot
  // appear, and at the end every comment must be closed.
  it("has balanced comment delimiters, so no rule is silently discarded", () => {
    let i = 0;
    let inComment = false;
    const problems: string[] = [];
    while (i < sheet.length) {
      const open = sheet.indexOf("/*", i);
      const close = sheet.indexOf("*/", i);
      if (!inComment) {
        if (close !== -1 && (open === -1 || close < open)) {
          problems.push(`stray "*/" at index ${close}: ${sheet.slice(Math.max(0, close - 60), close + 2).trim()}`);
          i = close + 2;
          continue;
        }
        if (open === -1) break;
        inComment = true;
        i = open + 2;
      } else {
        if (close === -1) {
          problems.push(`unclosed "/*" at index ${i}`);
          break;
        }
        inComment = false;
        i = close + 2;
      }
    }
    expect(problems).toEqual([]);
  });

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

describe("attention hue", () => {
  // Regression guard, and the reason --c-attn is the one status hue not wired to
  // the host's chart palette. VS Code registers charts.orange as inheriting from
  // minimap.findMatchHighlight instead of a literal, and stock Cursor Dark sets
  // that to #88C0D044 — 27%-alpha pale blue, grey once composited. The var()
  // fallback cannot save it: the variable is defined there, just wrong. Anyone
  // reaching for var(--vscode-charts-orange) again reintroduces a grey Action
  // required column in Cursor.
  it("fixes the hue instead of deriving it from charts.orange", () => {
    expect(TOKENS_CSS).toContain("--c-attn:     #e0913a");
    expect(stripComments(TOKENS_CSS)).not.toContain("--vscode-charts-orange");
  });

  // #e0913a is 2.54:1 on white. The sibling hues stay theme-derived, so they get
  // their light values from the host; this one has to carry its own.
  it("declares a light override that passes contrast", () => {
    expect(TOKENS_CSS).toMatch(/body\.vscode-light\s*{[^}]*--c-attn:\s*#a85c00/);
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
      // The Deck header's Orchestrator chip. A deliberate addition, and the
      // reason this list is worth keeping: it is the first --brand spend in
      // the header, and it is a TINT (hairline, label, 12% wash) rather than
      // the fill `.act.primary`/`.take` use, so it does not put a second
      // filled primary on the board. `.armed .ct` and `:hover` are the same
      // treatment at full strength; see the rules themselves in
      // orchestratorStyles.ts for why the hover restates `color`.
      ".orch-chip", ".orch-chip .ct", ".orch-chip:hover", ".orch-chip.armed .ct",
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

  // SURFACES covers the five surface sheets, and BASE_CSS is none of them — but it
  // is injected into all three webviews, so a --brand spend added here reaches every
  // surface while the per-sheet allowlists above stay green. The loading mark is the
  // one rule that may spend it; this keeps BASE_CSS from becoming the blind spot the
  // allowlists exist to prevent.
  it("spends --brand in BASE_CSS on exactly the loading mark", () => {
    const spenders = ruleBlocks(BASE_CSS).filter((r) => spendsBrandFill(r.body)).map((r) => r.selector);
    expect(spenders).toEqual([".lmark .ldot"]);
  });

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

describe("ticket kind hues", () => {
  // Red on a card means a real failure. A bug ticket is an ordinary, healthy
  // ticket, so it gets a muted red derived from --c-danger rather than the alarm
  // colour itself — and never --c-attn, which the Highest chip owns alone.
  it("mutes the bug hue away from the alarm red and the attention amber", () => {
    const bug = TOKENS_CSS.match(/--k-bug:\s*([^;]+);/);
    expect(bug).not.toBeNull();
    expect(bug![1]).toContain("color-mix");
    expect(bug![1]).toContain("--c-danger");
    expect(bug![1]).not.toContain("--c-attn");
    expect(bug![1].trim()).not.toBe("var(--c-danger)");
    // color-mix(in srgb, var(--c-danger) 100%, transparent) mutes nothing — it's
    // still 100% danger red, just alpha-blended over whatever sits behind it.
    // --vscode-foreground is the second colour that actually does the muting.
    expect(bug![1]).toContain("--vscode-foreground");
  });

  // Task and sub-task share a hue, as they do in Jira; their glyphs differ. Every
  // other kind is distinct, so a scan down the list separates them by colour.
  it("gives each kind a hue, sharing exactly one between task and sub-task", () => {
    const hue = (name: string) => TOKENS_CSS.match(new RegExp(`--k-${name}:\\s*([^;]+);`))![1].trim();
    const kinds = ["story", "epic", "task", "subtask", "bug", "other"];
    for (const k of kinds) expect(hue(k), k).toBeTruthy();
    expect(hue("task")).toBe(hue("subtask"));
    const distinct = new Set(kinds.map(hue));
    expect(distinct.size).toBe(5);
  });
});

describe("ticket type marker rules", () => {
  // The orphan check above only runs uses→declared: a --k-* token with no
  // .ty-<kind> rule left to spend it is invisible to it, since "declared but
  // unused" isn't a failure that check looks for. Deleting the whole .ty block
  // from styles.ts would leave every existing test green while every glyph
  // silently lost its hue and its flex: none. This guards that gap directly.
  it("gives .ty a fixed 12px box that flex can never squeeze out of the row", () => {
    const ty = ruleBlocks(CSS).find((r) => r.selector === ".ty");
    expect(ty).toBeDefined();
    expect(ty!.body).toMatch(/flex:\s*none/);
    expect(ty!.body).toMatch(/width:\s*12px/);
    expect(ty!.body).toMatch(/height:\s*12px/);
  });

  it("gives each kind's .ty-<kind> rule its own --k-<kind> hue", () => {
    const kinds = ["story", "epic", "task", "subtask", "bug", "other"];
    for (const kind of kinds) {
      const rule = ruleBlocks(CSS).find((r) => r.selector === `.ty-${kind}`);
      expect(rule, `.ty-${kind}`).toBeDefined();
      expect(rule!.body, `.ty-${kind}`).toContain(`var(--k-${kind})`);
    }
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

describe("notepad note layout", () => {
  // The note reads as text beside its actions: one column takes whatever width is
  // left and wraps inside it, the other is exactly as wide as the action cluster.
  // Stacking the cluster under the text (as a plain block flow does) gave the note a
  // dead band of empty card to the right of every title.
  it("puts the text and the actions in two columns", () => {
    const item = ruleBlocks(CSS).find((r) => r.selector === ".np-item");
    expect(item).toBeDefined();
    expect(item!.body).toMatch(/display:\s*grid/);
    expect(item!.body).toMatch(/grid-template-columns:\s*1fr max-content/);
  });

  // The cluster is taller than a one-line note, and a row-spanning item's excess
  // height is distributed into the auto tracks it spans — that is track sizing, not
  // free space, so align-content cannot touch it. Left alone it pushed the title off
  // the cluster's top edge and opened a gap above the body. A flexible third track
  // takes the excess instead, which keeps the title and body at content height. The
  // empty track collapses to nothing whenever the text is the taller side.
  it("absorbs the cluster's excess height in a track of its own", () => {
    const item = ruleBlocks(CSS).find((r) => r.selector === ".np-item")!;
    expect(item.body).toMatch(/grid-template-rows:\s*max-content max-content 1fr/);
  });

  it("keeps the title and the body in the text column", () => {
    for (const selector of [".np-top", ".np-body"]) {
      const rule = ruleBlocks(CSS).find((r) => r.selector === selector);
      expect(rule, selector).toBeDefined();
      expect(rule!.body, selector).toMatch(/grid-column:\s*1/);
    }
  });

  // The grip sits ahead of the checkbox in .np-top, pushing the title right by
  // the grip's own width. .np-body has no grip beside it, so its left margin
  // must add that same width back in from --grip-w, the one place it is
  // defined — a hardcoded literal here could drift from the grip's real width
  // and misalign the body under the title.
  it("derives the body's left offset from the grip's own width", () => {
    const body = ruleBlocks(CSS).find((r) => r.selector === ".np-body")!;
    expect(body.body).toMatch(/margin:\s*3px 0 0 calc\(var\(--grip-w\)\s*\+\s*7px\s*\+\s*20px\)/);
  });

  // Top of the card, right-hand side, however many lines the text runs to: the
  // cluster spans every row so the text cannot push it down, and align-self keeps it
  // from stretching to the note's full height.
  it("pins the action cluster to the top of the second column", () => {
    const acts = ruleBlocks(CSS).find((r) => r.selector === ".np-acts")!;
    expect(acts.body).toMatch(/grid-column:\s*2/);
    expect(acts.body).toMatch(/grid-row:\s*1 \/ -1/);
    expect(acts.body).toMatch(/align-self:\s*start/);
    // Its own column now places it; the auto margin that used to push it right would
    // fight that placement.
    expect(acts.body).not.toMatch(/margin:[^;]*\bauto\b/);
  });
});

describe("notepad note text", () => {
  // A dictated or pasted title can be one unbroken string, which has no wrap
  // opportunity. The title is a flex child at flex: 1, and a flex child's default
  // min-width: auto refuses to shrink below its min-content — so the string ran off
  // the panel's right edge instead of wrapping. min-width: 0 is what allows it to be
  // constrained at all; overflow-wrap is what breaks the string once it is.
  it("wraps a title with no wrap opportunity instead of overflowing the panel", () => {
    const title = ruleBlocks(CSS).find((r) => r.selector === ".np-top .np-title");
    expect(title).toBeDefined();
    expect(title!.body).toMatch(/min-width:\s*0/);
    expect(title!.body).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("wraps an unbroken body the same way", () => {
    const body = ruleBlocks(CSS).find((r) => r.selector === ".np-body");
    expect(body!.body).toMatch(/overflow-wrap:\s*anywhere/);
  });

  // The note is the user's own text: it wraps to as many lines as it needs, and
  // nothing is ever cut. Truncating would hide what they wrote with no way to read
  // it in place.
  it("never truncates or clamps the text it wraps", () => {
    const noteRules = ruleBlocks(CSS).filter((r) => /\.np-(title|body)\b/.test(r.selector));
    expect(noteRules.length).toBeGreaterThan(0);
    expect(noteRules.filter((r) => /text-overflow|line-clamp/.test(r.body))).toEqual([]);
  });
});

describe("notepad actions cluster", () => {
  const acts = () => ruleBlocks(CSS).find((r) => r.selector === ".np-acts")!;

  // Start sits above edit and delete, and the pair spans exactly Start's width.
  // A two-column grid is what ties the two rows to one measure; a flex row cannot,
  // and hardcoding the cluster width would drift the moment the label or the body
  // font size changes.
  it("lays the cluster out as two equal columns sized to its content", () => {
    expect(acts()).toBeDefined();
    expect(acts().body).toMatch(/display:\s*grid/);
    expect(acts().body).toMatch(/grid-template-columns:\s*1fr 1fr/);
    expect(acts().body).toMatch(/width:\s*max-content/);
  });

  it("spans Start across both columns", () => {
    const take = ruleBlocks(CSS).find((r) => r.selector === ".np-acts .take");
    expect(take).toBeDefined();
    expect(take!.body).toMatch(/grid-column:\s*1 \/ -1/);
    expect(take!.body).toMatch(/justify-content:\s*center/);
  });

  // .quiet.icon-only is pinned to 24px for the Tasks tab's inline rows. Left at that
  // width the pair would sit at 54px under an ~80px Start — the mismatch this whole
  // change is about. The release is scoped to .np-acts so Tasks keeps its 24px.
  it("releases the icon pair's global 24px width, inside the notepad only", () => {
    const iconOnly = ruleBlocks(CSS).find((r) => r.selector === ".np-acts .quiet.icon-only");
    expect(iconOnly).toBeDefined();
    expect(iconOnly!.body).toMatch(/width:\s*auto/);
    const shared = ruleBlocks(CSS).find((r) => r.selector === ".sprint-remove.icon-only, .quiet.icon-only");
    expect(shared!.body).toMatch(/width:\s*24px/);
  });
});
