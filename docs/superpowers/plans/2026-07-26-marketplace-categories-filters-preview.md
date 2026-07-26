# Marketplace category sections, plugin multi-select & file preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group the Marketplace's browse list by the plugin manifest's own `category` field, let the user narrow to several plugins and marketplaces at once, and fill the mostly-empty detail column with the selected asset's rendered file.

**Architecture:** Three pure engine modules do the thinking — `claudeAssets.ts` gains `category`/`readme`, a new `sections.ts` orders category sections, a new `markdown.ts` parses a markdown subset to a typed tree. The webview renders that tree as React elements (never `dangerouslySetInnerHTML`) and AND-s six filter dimensions. The host gains one message pair for reading a file, guarded by the allow-list it already maintains.

**Tech Stack:** TypeScript, React 18 (VS Code webview), vitest + @testing-library/react + jsdom, esbuild.

**Spec:** [`docs/superpowers/specs/2026-07-26-marketplace-categories-filters-preview-design.md`](../specs/2026-07-26-marketplace-categories-filters-preview-design.md)

## Global Constraints

- `src/engine/**` must **never** import `vscode` or `fs`. It is pure over injected readers and unit-tested from fixture trees via `memReader`.
- **No `dangerouslySetInnerHTML` anywhere in the preview path.** Third-party marketplace content is rendered as React elements from a typed tree.
- The webview may only read paths the host's `openable` allow-list contains.
- Preview truncation boundary: **262144 characters** — a proxy for parse/render cost, not wire size.
- Preview cache bound: **50 entries**, oldest evicted, cleared on rescan.
- Section order: **Yours** first, then categories by descending asset count (ties alphabetical by raw category), **Uncategorized** last.
- Category values are lower-cased raw manifest strings. Title-casing is display-only; filtering compares raw values.
- Coverage thresholds in `vitest.config.ts` must keep passing: statements 90, branches 85, functions 85, lines 90.
- Run the whole suite with `npm test`; a single file with `npx vitest run <path>`; a single test with `npx vitest run <path> -t "<name>"`.
- Commit after every task. Conventional-commit prefixes (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`), matching this repo's history.

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` | *(modify)* `category` on `AssetView`/`PluginRowView`, `readme` on `PluginRowView`, `mkt:read` inbound, `mkt:file` outbound |
| `src/engine/claudeAssets.ts` | *(modify)* populate `category` and `readme` during the scan |
| `src/engine/sections.ts` | *(create)* category display labels and section ordering — pure |
| `src/engine/markdown.ts` | *(create)* markdown subset → typed block/inline tree — pure |
| `src/marketplaceView.ts` | *(modify)* `mkt:read` handler, readmes in the allow-list, 262144-char cap |
| `src/webview/Markdown.tsx` | *(create)* renders a `Block[]` tree as React elements |
| `src/webview/PluginPicker.tsx` | *(create)* the searchable multi-select dropdown |
| `src/webview/FilePreview.tsx` | *(create)* the preview body — loading, empty, truncated, rendered |
| `src/webview/MarketplaceApp.tsx` | *(modify)* row model, six-dimension filtering, sections, chips, orchestration |
| `src/webview/marketplaceStyles.ts` | *(modify)* CSS for chips, picker, section headers, markdown body |

Tests mirror that structure under `test/unit/engine/`, `test/unit/`, and `test/webview/`.

---

### Task 1: `category` and `readme` in the scan

The manifest field already sits unread in `marketplace.json`. Surface it on every asset and plugin row, plus the path to each plugin's README.

**Files:**
- Modify: `src/types.ts:108-131`
- Modify: `src/engine/claudeAssets.ts:67-72` (`Attribution`), `:122-142` (`mdAsset`), `:145-180` (`flattenHooks`), `:317-388` (`scanClaudeAssets`)
- Test: `test/unit/engine/claudeAssets.test.ts`
- Modify (compile fix only): `test/webview/MarketplaceApp.test.tsx:17-25`, `test/unit/marketplaceView.test.ts:17-27`

**Interfaces:**
- Consumes: nothing.
- Produces: `AssetView.category: string`, `PluginRowView.category: string`, `PluginRowView.readme: string`. `Attribution` gains `category: string`. Values are lower-cased; `"yours"` for user/workspace assets, `"uncategorized"` when the manifest omits it.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/claudeAssets.test.ts` (the file already imports `describe/it/expect` and `memReader`; add `scanClaudeAssets` to the existing import from `../../../src/engine/claudeAssets`):

```ts
describe("scanClaudeAssets categories", () => {
  const tree = (over: Record<string, string> = {}) => ({
    "/h/.claude/plugins/known_marketplaces.json": JSON.stringify({
      atbay: { installLocation: "/mk", source: { source: "github", repo: "org/atbay" } },
    }),
    "/h/.claude/plugins/installed_plugins.json": JSON.stringify({ plugins: {} }),
    "/mk/.claude-plugin/marketplace.json": JSON.stringify({
      name: "atbay",
      plugins: [
        { name: "cicd", description: "Ships things", category: "Deployment" },
        { name: "plain", description: "No category" },
      ],
    }),
    "/mk/cicd/skills/build/SKILL.md": "---\nname: build\ndescription: d\n---",
    "/mk/cicd/hooks/hooks.json": JSON.stringify({ PreToolUse: [{ hooks: [{ command: "x.sh" }] }] }),
    "/mk/cicd/README.md": "# cicd",
    "/mk/plain/skills/other/SKILL.md": "---\nname: other\ndescription: d\n---",
    ...over,
  });
  const scan = (over?: Record<string, string>) =>
    scanClaudeAssets(memReader(tree(over)), { claudeDir: "/h/.claude", now: 1 });

  it("lower-cases the manifest category onto the plugin and its assets", () => {
    const v = scan();
    expect(v.plugins.find((p) => p.name === "cicd")!.category).toBe("deployment");
    expect(v.assets.find((a) => a.name === "build")!.category).toBe("deployment");
  });

  it("carries the category onto hooks too", () => {
    expect(scan().assets.find((a) => a.type === "hook")!.category).toBe("deployment");
  });

  it("falls back to uncategorized when the manifest omits the field", () => {
    const v = scan();
    expect(v.plugins.find((p) => p.name === "plain")!.category).toBe("uncategorized");
    expect(v.assets.find((a) => a.name === "other")!.category).toBe("uncategorized");
  });

  it("resolves a README in the plugin's content dir, case-insensitively", () => {
    expect(scan().plugins.find((p) => p.name === "cicd")!.readme).toBe("/mk/cicd/README.md");
    expect(scan().plugins.find((p) => p.name === "plain")!.readme).toBe("");
    const lower = scan({ "/mk/plain/readme.md": "# plain" });
    expect(lower.plugins.find((p) => p.name === "plain")!.readme).toBe("/mk/plain/readme.md");
  });

  it("labels your own assets 'yours' and gives their row no readme", () => {
    const v = scan({ "/h/.claude/skills/mine/SKILL.md": "---\nname: mine\ndescription: d\n---" });
    expect(v.assets.find((a) => a.name === "mine")!.category).toBe("yours");
    expect(v.plugins.find((p) => p.name === "(user)")!.category).toBe("yours");
    expect(v.plugins.find((p) => p.name === "(user)")!.readme).toBe("");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/claudeAssets.test.ts -t "categories"`
Expected: FAIL — `expect(received).toBe(expected)` with `received: undefined` for every `category` assertion.

- [ ] **Step 3: Add the fields to `src/types.ts`**

In `AssetView` (after `state: PluginState;`):

```ts
  /** The plugin manifest's `category`, lower-cased; "yours" for your own assets,
   * "uncategorized" when the manifest omits it. Groups the browse list. */
  category: string;
```

In `PluginRowView` (after `counts: Record<AssetType, number>;`):

```ts
  category: string; // same vocabulary as AssetView.category
  readme: string; // absolute path to the README in the content dir, or ""
```

- [ ] **Step 4: Populate them in `src/engine/claudeAssets.ts`**

Add to `Attribution`:

```ts
export interface Attribution {
  plugin: string;
  marketplace: string;
  category: string;
  state: PluginState;
  enabled: boolean | null;
}
```

In `mdAsset`, add `category: attr.category,` to the returned object (beside `marketplace`). In `flattenHooks`, add `category: attr.category,` to the pushed object (beside `marketplace`).

Add above `scanClaudeAssets`:

```ts
/** The manifest's category, normalised. Lower-cased so "Deployment" and
 * "deployment" are one section; absent becomes an explicit bucket rather than an
 * empty string, because "we don't know" is a thing the UI has to name. */
function categoryOf(plugin: { category?: unknown }): string {
  const raw = typeof plugin.category === "string" ? plugin.category.trim() : "";
  return raw ? raw.toLowerCase() : "uncategorized";
}

/** The plugin's own README, if it shipped one. Matched case-insensitively —
 * both README.md and readme.md occur in the wild. */
function readmeIn(reader: AssetReader, dir: string): string {
  if (!dir) return "";
  const hit = reader.readDir(dir).find((e) => !e.isDir && e.name.toLowerCase() === "readme.md");
  return hit ? `${dir}/${hit.name}` : "";
}
```

In the marketplace plugin loop, replace the `mine` line and extend the `plugins.push`:

```ts
      const category = categoryOf(p);
      const mine = dir
        ? discoverAssets(reader, dir, { plugin: p.name, marketplace: name, category, state, enabled })
        : [];
```

```ts
      plugins.push({
        name: p.name,
        marketplace: name,
        description: typeof p.description === "string" ? p.description : "",
        state,
        enabled,
        scopes: [...new Set(installs.map((i) => i.scope).filter((s): s is string => !!s))].sort(),
        version: used?.version ?? "",
        counts: countsOf(mine),
        category,
        readme: readmeIn(reader, dir),
        installCommand: `/plugin install ${ref}`,
      });
```

In the `own` helper, set the attribution category and the plugin row's two new fields:

```ts
    const attr: Attribution = { plugin, marketplace, category: "yours", state: "user", enabled: true };
```

```ts
        counts: countsOf(all),
        category: "yours",
        readme: "",
        installCommand: "",
```

- [ ] **Step 5: Fix the two test factories the new required fields break**

`test/webview/MarketplaceApp.test.tsx` — add `category: "deployment",` to the `asset()` defaults and `category: "deployment", readme: "",` to the `plugin()` defaults.

`test/unit/marketplaceView.test.ts` — add `category: "deployment",` to the inline asset in `view()`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/claudeAssets.test.ts && npm run typecheck`
Expected: PASS, and `tsc --noEmit` clean.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/engine/claudeAssets.ts test/unit/engine/claudeAssets.test.ts \
        test/webview/MarketplaceApp.test.tsx test/unit/marketplaceView.test.ts
git commit -m "feat(marketplace): read each plugin's category and README from the manifest"
```

---

### Task 2: Section ordering

**Files:**
- Create: `src/engine/sections.ts`
- Test: `test/unit/engine/sections.test.ts`

**Interfaces:**
- Consumes: `AssetView.category` from Task 1.
- Produces:
  - `categoryLabel(category: string): string`
  - `orderSections<T extends { category: string }>(rows: T[]): Section[]` where `interface Section { category: string; label: string; count: number }`

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/sections.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { categoryLabel, orderSections } from "../../../src/engine/sections";

const rows = (...cats: string[]) => cats.map((category) => ({ category }));

describe("categoryLabel", () => {
  it("title-cases a plain category", () => {
    expect(categoryLabel("development")).toBe("Development");
  });

  it("title-cases every word of a hyphenated or underscored category", () => {
    expect(categoryLabel("code-review")).toBe("Code Review");
    expect(categoryLabel("api_security")).toBe("Api Security");
  });

  it("names the two synthetic buckets", () => {
    expect(categoryLabel("yours")).toBe("Yours");
    expect(categoryLabel("uncategorized")).toBe("Uncategorized");
  });

  it("survives an empty category", () => {
    expect(categoryLabel("")).toBe("Uncategorized");
  });
});

describe("orderSections", () => {
  it("puts Yours first and Uncategorized last, with the rest by descending count", () => {
    const s = orderSections(rows(
      "uncategorized", "development", "development", "development",
      "yours", "productivity", "productivity", "uncategorized",
    ));
    expect(s.map((x) => x.category)).toEqual(["yours", "development", "productivity", "uncategorized"]);
    expect(s.map((x) => x.count)).toEqual([1, 3, 2, 2]);
  });

  it("breaks count ties alphabetically so the order never flickers between scans", () => {
    const s = orderSections(rows("security", "design", "monitoring"));
    expect(s.map((x) => x.category)).toEqual(["design", "monitoring", "security"]);
  });

  it("carries the display label on each section", () => {
    expect(orderSections(rows("code-review"))[0].label).toBe("Code Review");
  });

  it("returns nothing for no rows", () => {
    expect(orderSections([])).toEqual([]);
  });

  it("omits Yours and Uncategorized when nothing falls in them", () => {
    expect(orderSections(rows("development")).map((x) => x.category)).toEqual(["development"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/sections.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/engine/sections"`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/sections.ts`:

```ts
// Category sections for the Marketplace's browse list. Pure and dependency-free —
// it must never import "vscode" or "fs" — so the webview and the unit tests share
// one ordering rule.

/** Your own assets, pinned to the top: what you wrote is what you look for most. */
const FIRST = "yours";
/** Plugins whose manifest omits `category`, pinned to the bottom. */
const LAST = "uncategorized";

export interface Section {
  category: string; // the raw value, which is what filtering compares
  label: string; // title-cased, for display only
  count: number;
}

/** A category as a heading. Presentation only — never feed this back into a filter. */
export function categoryLabel(category: string): string {
  if (!category) return "Uncategorized";
  return category
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Sections in display order: Yours, then by descending row count, then
 * Uncategorized. Count ties break alphabetically so two scans of the same disk
 * never reorder the page under the user. */
export function orderSections<T extends { category: string }>(rows: T[]): Section[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const c = r.category || LAST;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const rank = (c: string) => (c === FIRST ? -1 : c === LAST ? 1 : 0);
  return [...counts.entries()]
    .sort(([ac, an], [bc, bn]) => rank(ac) - rank(bc) || bn - an || ac.localeCompare(bc))
    .map(([category, count]) => ({ category, label: categoryLabel(category), count }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/sections.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/sections.ts test/unit/engine/sections.test.ts
git commit -m "feat(marketplace): order the browse list's category sections"
```

---

### Task 3: The markdown parser

A documented subset, parsed to a typed tree. Unrecognised syntax falls through as literal text — a file renders plainer than its author intended, never wrongly.

**Files:**
- Create: `src/engine/markdown.ts`
- Test: `test/unit/engine/markdown.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseMarkdown(src: string): Block[]`, `parseInline(src: string): Inline[]`, and the exported `Block` / `Inline` union types used verbatim by `src/webview/Markdown.tsx` in Task 5.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/markdown.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseInline, parseMarkdown } from "../../../src/engine/markdown";

const text = (t: string) => ({ kind: "text", text: t });

describe("parseInline", () => {
  it("returns bare prose as one text span", () => {
    expect(parseInline("just words")).toEqual([text("just words")]);
  });

  it("reads code, bold, italic and links", () => {
    expect(parseInline("a `c` b")).toEqual([text("a "), { kind: "code", text: "c" }, text(" b")]);
    expect(parseInline("**b**")).toEqual([{ kind: "strong", children: [text("b")] }]);
    expect(parseInline("*i*")).toEqual([{ kind: "em", children: [text("i")] }]);
    expect(parseInline("_i_")).toEqual([{ kind: "em", children: [text("i")] }]);
    expect(parseInline("[go](https://x.dev)")).toEqual([
      { kind: "link", href: "https://x.dev", children: [text("go")] },
    ]);
  });

  it("prefers bold over italic for a doubled marker", () => {
    expect(parseInline("**b**")[0].kind).toBe("strong");
  });

  // Security: this content comes from arbitrary third-party marketplaces.
  it("renders a non-http link as inert text, keeping only its label", () => {
    expect(parseInline("[click](javascript:alert(1))")).toEqual([text("click")]);
    expect(parseInline("[open](file:///etc/passwd)")).toEqual([text("open")]);
  });

  it("leaves raw HTML as literal characters", () => {
    expect(parseInline("<script>alert(1)</script>")).toEqual([text("<script>alert(1)</script>")]);
  });

  it("leaves an unclosed marker literal", () => {
    expect(parseInline("a * b")).toEqual([text("a * b")]);
    expect(parseInline("`unclosed")).toEqual([text("`unclosed")]);
  });

  it("keeps a balanced paren inside an href", () => {
    expect(parseInline("[wiki](https://x.dev/a_(b))")).toEqual([
      { kind: "link", href: "https://x.dev/a_(b)", children: [text("wiki")] },
    ]);
  });
});

describe("parseMarkdown", () => {
  it("drops a leading frontmatter block", () => {
    expect(parseMarkdown("---\nname: a\ndescription: b\n---\n# Head\n")).toEqual([
      { kind: "heading", level: 1, children: [text("Head")] },
    ]);
  });

  it("reads headings at every level", () => {
    expect(parseMarkdown("### Three")).toEqual([
      { kind: "heading", level: 3, children: [text("Three")] },
    ]);
  });

  it("joins wrapped lines into one paragraph and splits on a blank line", () => {
    const b = parseMarkdown("one\ntwo\n\nthree");
    expect(b).toEqual([
      { kind: "para", children: [text("one two")] },
      { kind: "para", children: [text("three")] },
    ]);
  });

  it("reads a fenced block with its language, verbatim", () => {
    expect(parseMarkdown("```bash\nls -la\n# not a heading\n```")).toEqual([
      { kind: "fence", lang: "bash", text: "ls -la\n# not a heading" },
    ]);
  });

  it("keeps the rest of the file when a fence is never closed", () => {
    expect(parseMarkdown("```\nstill here")).toEqual([{ kind: "fence", lang: "", text: "still here" }]);
  });

  it("reads unordered and ordered lists", () => {
    expect(parseMarkdown("- a\n- b")).toEqual([
      { kind: "list", ordered: false, items: [[text("a")], [text("b")]] },
    ]);
    expect(parseMarkdown("1. a\n2. b")).toEqual([
      { kind: "list", ordered: true, items: [[text("a")], [text("b")]] },
    ]);
  });

  it("flattens a nested list into its parent — documented subset behaviour", () => {
    expect(parseMarkdown("- a\n  - b")).toEqual([
      { kind: "list", ordered: false, items: [[text("a")], [text("b")]] },
    ]);
  });

  it("reads a blockquote and a horizontal rule", () => {
    expect(parseMarkdown("> quoted\n> more")).toEqual([
      { kind: "quote", children: [text("quoted more")] },
    ]);
    expect(parseMarkdown("***")).toEqual([{ kind: "rule" }]);
  });

  it("reads a pipe table", () => {
    expect(parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |")).toEqual([
      {
        kind: "table",
        head: [[text("a")], [text("b")]],
        rows: [[[text("1")], [text("2")]]],
      },
    ]);
  });

  it("treats a pipe line with no divider as a paragraph", () => {
    expect(parseMarkdown("| a | b |")).toEqual([{ kind: "para", children: [text("| a | b |")] }]);
  });

  it("tolerates CRLF line endings", () => {
    expect(parseMarkdown("# Head\r\n\r\nbody\r\n")).toEqual([
      { kind: "heading", level: 1, children: [text("Head")] },
      { kind: "para", children: [text("body")] },
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
  });

  it("terminates on a 300 KB body", () => {
    const src = "para line\n\n".repeat(30_000);
    expect(src.length).toBeGreaterThan(300_000);
    expect(parseMarkdown(src)).toHaveLength(30_000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/markdown.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/engine/markdown"`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/markdown.ts`:

```ts
// A small CommonMark subset, parsed to a typed tree. Pure and dependency-free —
// it must never import "vscode" or "fs".
//
// The tree exists so the webview can render third-party marketplace files as React
// elements instead of HTML. Nothing here produces markup, so injection is
// structurally impossible rather than dependent on a sanitiser being configured
// correctly. Anything the grammar below doesn't recognise survives as literal text:
// a file renders plainer than its author intended, never wrongly.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "para"; children: Inline[] }
  | { kind: "fence"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "quote"; children: Inline[] }
  | { kind: "rule" }
  | { kind: "table"; head: Inline[][]; rows: Inline[][][] };

/** Only these become anchors. `file:`, `javascript:` and every other scheme keep
 * their label and lose the link — the source is an arbitrary third party. */
const SAFE_HREF = /^https?:\/\//i;

/** Split one run of markdown into inline spans. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = (): void => {
    if (text) out.push({ kind: "text", text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m = /^`([^`]+)`/.exec(rest);
    if (m) {
      flush();
      out.push({ kind: "code", text: m[1] });
      i += m[0].length;
      continue;
    }
    m = /^\*\*([^*]+)\*\*/.exec(rest);
    if (m) {
      flush();
      out.push({ kind: "strong", children: parseInline(m[1]) });
      i += m[0].length;
      continue;
    }
    m = /^\*([^*]+)\*/.exec(rest) ?? /^_([^_]+)_/.exec(rest);
    if (m) {
      flush();
      out.push({ kind: "em", children: parseInline(m[1]) });
      i += m[0].length;
      continue;
    }
    // URLs legitimately contain balanced parens — Wikipedia titles are the usual
    // case — and a naive [^)]* stops at the first one, leaking the remainder into
    // the text run. One level of nesting covers everything seen in the wild.
    m = /^\[([^\]]*)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/.exec(rest);
    if (m) {
      flush();
      const label = m[1] || m[2];
      if (SAFE_HREF.test(m[2])) out.push({ kind: "link", href: m[2], children: parseInline(label) });
      else out.push({ kind: "text", text: label });
      i += m[0].length;
      continue;
    }
    text += src[i];
    i++;
  }
  flush();
  return out;
}

const FENCE = /^\s*```(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const ROW = /^\s*\|(.*)\|\s*$/;

const isRow = (s: string): boolean => ROW.test(s);
const isDivider = (s: string): boolean => isRow(s) && /^[\s:|-]+$/.test(s);
const cells = (s: string): Inline[][] =>
  ROW.exec(s)![1].split("|").map((c) => parseInline(c.trim()));

/** Drop a leading `---` frontmatter block — the detail pane above the preview
 * already shows everything it holds. */
function stripFrontmatter(src: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(src);
  return m ? src.slice(m[0].length) : src;
}

/** Parse a document into blocks. Nested lists flatten into their parent and a
 * blockquote holds a single run — both deliberate, both cheaper than the nesting
 * machinery a full parser needs and neither ever renders something misleading. */
export function parseMarkdown(src: string): Block[] {
  const lines = stripFrontmatter(src ?? "").split(/\r?\n/);
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      // An unterminated fence swallows the remainder rather than dropping it.
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      out.push({ kind: "fence", lang: fence[1].trim(), text: body.join("\n") });
      continue;
    }

    if (RULE.test(line)) {
      out.push({ kind: "rule" });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ kind: "heading", level: heading[1].length, children: parseInline(heading[2].trim()) });
      i++;
      continue;
    }

    if (isRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && isRow(lines[i]) && !isDivider(lines[i])) rows.push(cells(lines[i++]));
      out.push({ kind: "table", head, rows });
      continue;
    }

    if (UL.test(line) || OL.test(line)) {
      const ordered = !UL.test(line);
      const items: Inline[][] = [];
      while (i < lines.length && (UL.test(lines[i]) || OL.test(lines[i]))) {
        const item = UL.exec(lines[i]) ?? OL.exec(lines[i])!;
        items.push(parseInline(item[1]));
        i++;
      }
      out.push({ kind: "list", ordered, items });
      continue;
    }

    if (QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) buf.push(QUOTE.exec(lines[i++])![1]);
      out.push({ kind: "quote", children: parseInline(buf.join(" ").trim()) });
      continue;
    }

    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !RULE.test(lines[i]) &&
      !UL.test(lines[i]) &&
      !OL.test(lines[i]) &&
      !QUOTE.test(lines[i]) &&
      !(isRow(lines[i]) && i + 1 < lines.length && isDivider(lines[i + 1]))
    ) {
      buf.push(lines[i++]);
    }
    // buf can only be empty if the line opens a construct every branch above
    // rejected; advancing here is what stops the loop spinning on it.
    if (buf.length) out.push({ kind: "para", children: parseInline(buf.join(" ").trim()) });
    else i++;
  }

  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/markdown.test.ts`
Expected: PASS — 20 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/markdown.ts test/unit/engine/markdown.test.ts
git commit -m "feat(marketplace): parse a markdown subset to a typed tree"
```

---

### Task 4: The host reads a file on request

**Files:**
- Modify: `src/types.ts:174-178` (inbound), `:199-200` (outbound)
- Modify: `src/marketplaceView.ts:6` (constant), `:78` (allow-list), `:92-116` (handler)
- Test: `test/unit/marketplaceView.test.ts`

**Interfaces:**
- Consumes: `PluginRowView.readme` from Task 1.
- Produces: inbound `{ type: "mkt:read"; file: string }`, outbound `{ type: "mkt:file"; file: string; text: string; truncated: boolean }`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/marketplaceView.test.ts`. The existing `h` hoisted mock only stubs `fsReader` as `vi.fn(() => ({}))` — widen it to a readable stub first by replacing that line:

```ts
const h = vi.hoisted(() => ({
  scanClaudeAssets: vi.fn(),
  readFile: vi.fn<(p: string) => string | null>(() => null),
  fsReader: vi.fn(),
  claudeConfigDir: vi.fn(() => "/home/u/.claude"),
}));
h.fsReader.mockImplementation(() => ({ readFile: h.readFile, readDir: () => [], isDir: () => false }));
```

Add `h.readFile.mockReset().mockReturnValue(null);` to the existing `beforeEach`, then append:

```ts
describe("MarketplacePanel file preview", () => {
  const FILE = "/home/u/.claude/plugins/cache/atbay/cicd/1/skills/build/SKILL.md";

  it("returns a listed file's contents", async () => {
    h.readFile.mockReturnValue("# Build\n");
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:read", file: FILE });
    expect(posts(p).at(-1)).toEqual({ type: "mkt:file", file: FILE, text: "# Build\n", truncated: false });
  });

  it("returns empty text rather than an error when the file cannot be read", async () => {
    h.readFile.mockReturnValue(null);
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:read", file: FILE });
    expect(posts(p).at(-1)).toEqual({ type: "mkt:file", file: FILE, text: "", truncated: false });
  });

  it("refuses a path the last scan never listed", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:read", file: "/etc/passwd" });
    expect(posts(p).some((m) => m.type === "mkt:file")).toBe(false);
    expect(posts(p).at(-1).type).toBe("toast");
  });

  it("serves a plugin README, which the scan lists alongside asset files", async () => {
    h.scanClaudeAssets.mockReturnValue(view({
      plugins: [{
        name: "cicd", marketplace: "atbay", description: "d", state: "installed", enabled: true,
        scopes: [], version: "", counts: { skill: 0, command: 0, agent: 0, hook: 0 },
        category: "deployment", readme: "/mk/cicd/README.md", installCommand: "",
      }],
    }));
    h.readFile.mockReturnValue("# cicd");
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:read", file: "/mk/cicd/README.md" });
    expect(posts(p).at(-1)).toMatchObject({ type: "mkt:file", text: "# cicd" });
  });

  it("truncates at 256 KB and says so", async () => {
    h.readFile.mockReturnValue("x".repeat(262_145));
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:read", file: FILE });
    const msg = posts(p).at(-1);
    expect(msg.truncated).toBe(true);
    expect(msg.text).toHaveLength(262_144);
  });

  it("does not flag a file that lands exactly on the boundary", async () => {
    h.readFile.mockReturnValue("x".repeat(262_144));
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:read", file: FILE });
    expect(posts(p).at(-1).truncated).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/marketplaceView.test.ts -t "file preview"`
Expected: FAIL — no `mkt:file` is ever posted; the last post stays `mkt:loading`.

- [ ] **Step 3: Add the messages to `src/types.ts`**

In `InboundMessage`, after `| { type: "mkt:reveal"; file: string }` change the terminator and add:

```ts
  | { type: "mkt:reveal"; file: string }
  | { type: "mkt:read"; file: string };
```

In `OutboundMessage`, after `| { type: "mkt:loading"; loading: boolean }`:

```ts
  | { type: "mkt:loading"; loading: boolean }
  // Contents of one previewed file. Never part of the scan payload: 350-odd
  // markdown bodies would bloat every rescan, and the panel rescans on refocus.
  | { type: "mkt:file"; file: string; text: string; truncated: boolean };
```

- [ ] **Step 4: Implement the handler in `src/marketplaceView.ts`**

Beside `STALE_MS`:

```ts
const MAX_PREVIEW = 262_144; // chars, not bytes — bounds parse/render cost, which scales with length
```

In `render()`, widen the allow-list:

```ts
    this.openable = new Set([
      ...view.assets.map((a) => a.file),
      ...view.plugins.map((p) => p.readme).filter(Boolean),
    ]);
```

In `onMessage`, before the `mkt:copy` case:

```ts
      case "mkt:read": {
        if (!this.allowed(m.file)) return;
        const raw = fsReader().readFile(m.file) ?? "";
        const truncated = raw.length > MAX_PREVIEW;
        this.post({
          type: "mkt:file",
          file: m.file,
          text: truncated ? raw.slice(0, MAX_PREVIEW) : raw,
          truncated,
        });
        break;
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/marketplaceView.test.ts && npm run typecheck`
Expected: PASS, `tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/marketplaceView.ts test/unit/marketplaceView.test.ts
git commit -m "feat(marketplace): serve a listed file's contents to the panel, capped at 256 KB"
```

---

### Task 5: The markdown renderer component

**Files:**
- Create: `src/webview/Markdown.tsx`
- Test: `test/webview/Markdown.test.tsx`

**Interfaces:**
- Consumes: `parseMarkdown`, `Block`, `Inline` from Task 3; `send` from `./vscodeApi`.
- Produces: `<Markdown text={string} />`, rendering into `<div className="md">`.

- [ ] **Step 1: Write the failing test**

Create `test/webview/Markdown.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/webview/Markdown.test.tsx`
Expected: FAIL — `Failed to resolve import "../../src/webview/Markdown"`.

- [ ] **Step 3: Write the implementation**

Create `src/webview/Markdown.tsx`:

```tsx
import * as React from "react";
import { send } from "./vscodeApi";
import { Block, Inline, parseMarkdown } from "../engine/markdown";

function inlines(nodes: Inline[]): React.ReactNode {
  return nodes.map((n, i) => {
    switch (n.kind) {
      case "text":
        return <React.Fragment key={i}>{n.text}</React.Fragment>;
      case "code":
        return <code key={i}>{n.text}</code>;
      case "strong":
        return <strong key={i}>{inlines(n.children)}</strong>;
      case "em":
        return <em key={i}>{inlines(n.children)}</em>;
      case "link":
        // The webview has no browser to navigate to; the host owns opening URLs.
        return (
          <a
            key={i}
            href={n.href}
            onClick={(e) => {
              e.preventDefault();
              send({ type: "openExternal", url: n.href });
            }}
          >
            {inlines(n.children)}
          </a>
        );
    }
  });
}

function block(b: Block, i: number): JSX.Element {
  switch (b.kind) {
    case "heading": {
      const H = `h${Math.min(b.level, 6)}` as "h1";
      return <H key={i}>{inlines(b.children)}</H>;
    }
    case "para":
      return <p key={i}>{inlines(b.children)}</p>;
    case "fence":
      return (
        <pre key={i}>
          <code>{b.text}</code>
        </pre>
      );
    case "rule":
      return <hr key={i} />;
    case "quote":
      return <blockquote key={i}>{inlines(b.children)}</blockquote>;
    case "list":
      return b.ordered ? (
        <ol key={i}>{b.items.map((it, j) => <li key={j}>{inlines(it)}</li>)}</ol>
      ) : (
        <ul key={i}>{b.items.map((it, j) => <li key={j}>{inlines(it)}</li>)}</ul>
      );
    case "table":
      return (
        <table key={i}>
          <thead>
            <tr>{b.head.map((c, j) => <th key={j}>{inlines(c)}</th>)}</tr>
          </thead>
          <tbody>
            {b.rows.map((r, j) => (
              <tr key={j}>{r.map((c, k) => <td key={k}>{inlines(c)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      );
  }
}

/** Renders a markdown subset as elements. Deliberately never uses
 * dangerouslySetInnerHTML: the source is a file from an arbitrary third-party
 * marketplace, and building the DOM from a typed tree makes injection
 * structurally impossible rather than sanitiser-dependent. */
export function Markdown({ text }: { text: string }): JSX.Element {
  const blocks = React.useMemo(() => parseMarkdown(text), [text]);
  return <div className="md">{blocks.map(block)}</div>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/webview/Markdown.test.tsx && npm run typecheck`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/webview/Markdown.tsx test/webview/Markdown.test.tsx
git commit -m "feat(marketplace): render the markdown tree as React elements"
```

---

### Task 6: Category sections in the browse list

Replaces the type-based group headers. Clicking a header focuses that category; a chip row appears to clear it.

**Files:**
- Modify: `src/webview/MarketplaceApp.tsx:24-39` (`Row`), `:53-91` (row builders), `:120-197` (state, sift, rows, grouping), `:225-250` (bar), `:262-296` (list)
- Modify: `src/webview/marketplaceStyles.ts:63-66`
- Test: `test/webview/MarketplaceApp.test.tsx`

**Interfaces:**
- Consumes: `AssetView.category` / `PluginRowView.category` (Task 1); `orderSections`, `categoryLabel`, `Section` (Task 2).
- Produces: `Row` gains `plugin: string; marketplace: string; category: string; readme: string`. `Row.plugin`/`Row.marketplace` are the raw fields, not the joined `where` string — Tasks 7 and 8 key their selections off them. A new `.chips` row and `.grouphd` click target exist in the DOM.

- [ ] **Step 1: Write the failing test**

Append to `test/webview/MarketplaceApp.test.tsx`. First extend `view()`'s assets so more than one category is present — replace the `assets:` array in the `view` factory with:

```ts
  assets: [
    asset(),
    asset({ type: "command", name: "deploy", description: "Ships it", file: "/a/commands/deploy.md", rel: "commands/deploy.md" }),
    asset({ type: "agent", name: "pipeline", description: "Runs CI", file: "/a/agents/pipeline.md", rel: "agents/pipeline.md" }),
    asset({ type: "hook", name: "SessionStart", description: "node hook.js", file: "/a/hooks/hooks.json", rel: "hooks/hooks.json" }),
    asset({ name: "watch", description: "Watches things", plugin: "gc-plugin", category: "monitoring", file: "/b/skills/watch/SKILL.md" }),
    asset({ name: "mine", description: "My own skill", plugin: "(user)", marketplace: "~/.claude", category: "yours", state: "user", file: "/u/skills/mine/SKILL.md" }),
  ],
```

**Expect fallout in the pre-existing tests in this file.** Two new assets change which
row is selected by default: rows now sort Yours-first, so the detail pane opens on `mine`
rather than `build`. Any existing assertion that assumed `build` was selected needs
updating to match — that is a correct consequence of the new ordering, not a regression.
Run the whole file, not just the new block.

Then append:

```ts
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
    expect(screen.queryByRole("button", { name: /^Monitoring/ })).not.toBeInTheDocument();
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/webview/MarketplaceApp.test.tsx -t "category sections"`
Expected: FAIL — no button matches `/^Yours/`; the headers are still `Skills`/`Commands`/`Agents`/`Hooks` divs.

- [ ] **Step 3: Extend the row model**

In `src/webview/MarketplaceApp.tsx`, add to `interface Row` (after `where: string;`):

```ts
  plugin: string; // raw, for the plugin filter — `where` is a display string
  marketplace: string; // raw, for the marketplace filter
  category: string;
  readme: string; // plugin rows only; "" for assets
```

In `assetRow`, after `where: …`:

```ts
    plugin: a.plugin,
    marketplace: a.marketplace,
    category: a.category,
    readme: "",
```

In `pluginRow`, after `where: p.marketplace,`:

```ts
    plugin: p.name,
    marketplace: p.marketplace,
    category: p.category,
    readme: p.readme,
```

Add the import at the top:

```ts
import { orderSections, Section } from "../engine/sections";
```

- [ ] **Step 4: Add category state, a skippable sift, and section-ordered rows**

Replace `TYPE_ORDER`'s trailing comment block usage in the `rows` memo. Add state beside the existing `useState` calls:

```ts
  const [cat, setCat] = React.useState<string | null>(null);
```

Replace the `sift` callback with one that can leave a dimension out, so a section header can count what it would show:

```ts
  /** Query and scope are applied before the type filter, so the pills can tally
   * what the query actually leaves and the counts move as you type. `skip` drops
   * one dimension so a control can count the rows it would reveal rather than the
   * rows already surviving it. */
  const sift = React.useCallback(
    (base: Row[], skip: "category" | "" = ""): Scored[] => {
      const out: Scored[] = [];
      for (const r of base) {
        if (scope === "installed" && r.state !== "installed" && r.state !== "user") continue;
        if (scope === "enabled" && r.enabled === false) continue;
        if (skip !== "category" && cat && r.category !== cat) continue;
        const score = searching ? rowScore(r, terms) : 0;
        if (score === null) continue;
        out.push({ ...r, score });
      }
      return out;
    },
    [terms, searching, scope, cat],
  );
```

Replace the `assets` / `plugins` memos with four, and derive the sections:

```ts
  const assetRows = React.useMemo(() => view.assets.map(assetRow), [view]);
  const pluginRows = React.useMemo(() => view.plugins.map(pluginRow), [view]);

  const assets = React.useMemo(() => sift(assetRows), [assetRows, sift]);
  const plugins = React.useMemo(() => sift(pluginRows), [pluginRows, sift]);
  const assetsNoCat = React.useMemo(() => sift(assetRows, "category"), [assetRows, sift]);
  const pluginsNoCat = React.useMemo(() => sift(pluginRows, "category"), [pluginRows, sift]);

  /** Rows of the active type, from a pair that has already been sifted. */
  const forType = React.useCallback(
    (a: Scored[], p: Scored[]): Scored[] =>
      type === "plugins" ? p : type === "all" ? a : a.filter((r) => r.type === type),
    [type],
  );

  // Sections count what they would reveal, so they exclude the category dimension
  // but honour every other one.
  const sections: Section[] = React.useMemo(
    () => (searching || cat ? [] : orderSections(forType(assetsNoCat, pluginsNoCat))),
    [assetsNoCat, pluginsNoCat, forType, searching, cat],
  );
```

Replace the `rows` memo:

```ts
  const rows = React.useMemo(() => {
    const picked = forType(assets, plugins);
    if (searching) return [...picked].sort((a, b) => b.score - a.score);
    // Section order first, then the old type order inside a section, so a block
    // still reads Skills → Commands → Agents → Hooks. Both sorts are stable, so
    // the scan's plugin-clustered order survives inside each run.
    const rank = new Map(sections.map((s, i) => [s.category, i]));
    const byType = (r: Scored) => (r.type ? TYPE_ORDER[r.type] : 0);
    return [...picked].sort(
      (a, b) => (rank.get(a.category) ?? 0) - (rank.get(b.category) ?? 0) || byType(a) - byType(b),
    );
  }, [assets, plugins, forType, searching, sections]);
```

Replace the grouping flag and the loop cursor:

```ts
  // Headers only when browsing: a search is ranked by relevance, so grouping it
  // would put a header above nearly every row. A focused category needs none —
  // the chip already says which one you are in.
  const grouped = !searching && !cat;
```

Replace `let lastType: AssetType | null | undefined;` with:

```ts
  let lastCat: string | undefined;
```

- [ ] **Step 5: Render the headers as buttons and add the chip row**

In the results list, replace the `head` line and its `<div className="grouphd">` block:

```tsx
              rows.map((r, i) => {
                const head = grouped && r.category !== lastCat ? ((lastCat = r.category), r.category) : null;
                const section = head ? sections.find((s) => s.category === head) : null;
                return (
                  <React.Fragment key={r.key}>
                    {section && (
                      <button
                        type="button"
                        className="grouphd"
                        onClick={() => { setCat(section.category); setSel(0); }}
                      >
                        <span className="lb">{section.label}</span>
                        <span className="n">{section.count}</span>
                        <span className="rule" />
                      </button>
                    )}
```

Below the scope `.pills` div and above the `view.marketplaces.length > 0` block, add the chip row:

```tsx
        {cat && (
          <div className="chips">
            <button type="button" className="chip" onClick={() => { setCat(null); setSel(0); }}>
              {categoryLabel(cat)} ×
            </button>
          </div>
        )}
```

Extend the import to `import { categoryLabel, orderSections, Section } from "../engine/sections";`.

- [ ] **Step 6: Style the header button and the chips**

In `src/webview/marketplaceStyles.ts`, replace the `.grouphd` rules with:

```css
  .grouphd { display: flex; align-items: center; gap: 8px; width: 100%; padding: 11px 18px 5px;
    background: transparent; border: 0; cursor: pointer; font-family: inherit; text-align: left; }
  .grouphd:hover .lb { color: var(--vscode-foreground); }
  .grouphd .lb { font-size: 10px; text-transform: uppercase; letter-spacing: .09em;
    color: var(--vscode-descriptionForeground); font-weight: 600; }
  .grouphd .n { font-family: var(--mono); font-size: 10px; color: var(--vscode-descriptionForeground); }
  .grouphd .rule { flex: 1; height: 1px; background: var(--hair); }

  .chips { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
  .chip { cursor: pointer; font-family: inherit; font-size: 11px; padding: 3px 9px; border-radius: 20px;
    border: 1px solid var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground); }
  .chip:hover { opacity: .85; }
  .chip.clear { border-color: var(--hair); background: transparent; color: var(--vscode-descriptionForeground); }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/webview/MarketplaceApp.test.tsx && npm run typecheck`
Expected: PASS — the pre-existing tests in that file still pass alongside the 8 new ones.

- [ ] **Step 8: Commit**

```bash
git add src/webview/MarketplaceApp.tsx src/webview/marketplaceStyles.ts test/webview/MarketplaceApp.test.tsx
git commit -m "feat(marketplace): group the browse list by category, click a header to focus it"
```

---

### Task 7: Plugin multi-select

**Files:**
- Create: `src/webview/PluginPicker.tsx`
- Modify: `src/webview/MarketplaceApp.tsx` (sift, picker items, chips, row click)
- Modify: `src/webview/marketplaceStyles.ts`
- Test: `test/webview/PluginPicker.test.tsx`, `test/webview/MarketplaceApp.test.tsx`

**Interfaces:**
- Consumes: `Row.plugin`, `Row.marketplace` from Task 6.
- Produces:
  - `interface PickerItem { key: string; name: string; marketplace: string; count: number }`
  - `<PluginPicker items={PickerItem[]} selected={string[]} onToggle={(key: string) => void} onClear={() => void} />`
  - Selection keys are `` `${plugin}@${marketplace}` `` — plugin names collide across marketplaces.

- [ ] **Step 1: Write the failing test for the picker**

Create `test/webview/PluginPicker.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/webview/PluginPicker.test.tsx`
Expected: FAIL — `Failed to resolve import "../../src/webview/PluginPicker"`.

- [ ] **Step 3: Write the picker**

Create `src/webview/PluginPicker.tsx`:

```tsx
import * as React from "react";

export interface PickerItem {
  key: string; // `${plugin}@${marketplace}` — plugin names collide across marketplaces
  name: string;
  marketplace: string;
  count: number;
}

/** The multi-select over plugins. A dropdown rather than pills because three
 * hundred plugins is far past what a pill row can hold. */
export function PluginPicker({
  items,
  selected,
  onToggle,
  onClear,
}: {
  items: PickerItem[];
  selected: string[];
  onToggle: (key: string) => void;
  onClear: () => void;
}): JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((i) => i.name.toLowerCase().includes(needle)) : items;

  return (
    <div className="picker">
      <button type="button" className={`pill${selected.length ? " on" : ""}`} onClick={() => setOpen(!open)}>
        Plugins ▾{selected.length > 0 && <span className="n">{selected.length}</span>}
      </button>
      {open && (
        <div className="pop">
          <input
            className="pq"
            value={q}
            spellCheck={false}
            autoFocus
            placeholder="Filter plugins…"
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="plist">
            {shown.map((i) => (
              <label key={i.key} className="pitem">
                <input
                  type="checkbox"
                  aria-label={i.name}
                  checked={selected.includes(i.key)}
                  onChange={() => onToggle(i.key)}
                />
                <span className="pn">{i.name}</span>
                <span className="pm">{i.marketplace}</span>
                <span className="n">{i.count}</span>
              </label>
            ))}
            {shown.length === 0 && <div className="pempty">No plugin matches “{q.trim()}”.</div>}
          </div>
          {selected.length > 0 && (
            <button type="button" className="btn pclear" onClick={onClear}>
              Clear {selected.length}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the picker test to verify it passes**

Run: `npx vitest run test/webview/PluginPicker.test.tsx`
Expected: PASS — 9 tests.

- [ ] **Step 5: Write the failing wiring test**

Append to `test/webview/MarketplaceApp.test.tsx`:

```ts
describe("MarketplaceApp plugin filter", () => {
  const openPicker = () => fireEvent.click(screen.getByRole("button", { name: /^Plugins ▾/ }));

  it("narrows to the checked plugins and AND-s them with the type pill", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    openPicker();
    fireEvent.click(screen.getByLabelText("gc-plugin"));
    expect(rowText("watch")).toBeInTheDocument();
    expect(screen.queryByText("/deploy")).not.toBeInTheDocument();
  });

  it("keeps several plugins at once", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    openPicker();
    fireEvent.click(screen.getByLabelText("gc-plugin"));
    fireEvent.click(screen.getByLabelText("cicd-plugin"));
    expect(rowText("watch")).toBeInTheDocument();
    expect(screen.getAllByText("/deploy").length).toBeGreaterThan(0);
  });

  it("adds a plugin from the name in a result row", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getAllByText("gc-plugin")[0]);
    expect(screen.getByRole("button", { name: /gc-plugin ×/ })).toBeInTheDocument();
    expect(screen.queryByText("pipeline")).not.toBeInTheDocument();
  });

  it("removes a plugin from its chip", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getAllByText("gc-plugin")[0]);
    fireEvent.click(screen.getByRole("button", { name: /gc-plugin ×/ }));
    expect(screen.getAllByText("pipeline").length).toBeGreaterThan(0);
  });

  it("counts picker items against every dimension but the plugin one", () => {
    const { container } = render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /^Skills/ }));
    openPicker();
    // "cicd-plugin" also appears as the clickable plugin name on every one of its
    // rows, so scope the lookup to the popup rather than the whole document.
    const item = (name: string) =>
      [...container.querySelectorAll(".pop .pitem")].find((l) => l.textContent!.startsWith(name))!;
    // cicd-plugin has one skill among its four assets; gc-plugin has its one.
    expect(item("cicd-plugin").textContent).toContain("1");
    // Selecting one plugin must not zero the others out of reach of their own box.
    fireEvent.click(screen.getByLabelText("gc-plugin"));
    expect(item("cicd-plugin")).toBeTruthy();
  });

  it("clears every chip at once", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getAllByText("gc-plugin")[0]);
    fireEvent.click(screen.getByRole("button", { name: /^Clear$/ }));
    expect(screen.queryByRole("button", { name: /gc-plugin ×/ })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run test/webview/MarketplaceApp.test.tsx -t "plugin filter"`
Expected: FAIL — no button matches `/^Plugins ▾/`.

- [ ] **Step 7: Wire the picker into `MarketplaceApp`**

Import it and add state:

```ts
import { PickerItem, PluginPicker } from "./PluginPicker";
```

```ts
  const [pluginSel, setPluginSel] = React.useState<string[]>([]);
```

Add the key helper beside `pluginRow`:

```ts
/** Plugin identity for filtering. Names collide across marketplaces. */
const pluginKey = (r: { plugin: string; marketplace: string }): string => `${r.plugin}@${r.marketplace}`;
```

Widen `sift`'s `skip` and add the dimension:

```ts
  const sift = React.useCallback(
    (base: Row[], skip: "category" | "plugin" | "" = ""): Scored[] => {
      const out: Scored[] = [];
      for (const r of base) {
        if (scope === "installed" && r.state !== "installed" && r.state !== "user") continue;
        if (scope === "enabled" && r.enabled === false) continue;
        if (skip !== "category" && cat && r.category !== cat) continue;
        if (skip !== "plugin" && pluginSel.length && !pluginSel.includes(pluginKey(r))) continue;
        const score = searching ? rowScore(r, terms) : 0;
        if (score === null) continue;
        out.push({ ...r, score });
      }
      return out;
    },
    [terms, searching, scope, cat, pluginSel],
  );
```

Add the picker's own sift pass and derive its items:

```ts
  const assetsNoPlugin = React.useMemo(() => sift(assetRows, "plugin"), [assetRows, sift]);
  const pluginsNoPlugin = React.useMemo(() => sift(pluginRows, "plugin"), [pluginRows, sift]);

  // Counted against every dimension except the plugin one, so the numbers show
  // what checking a box would reveal. Already-selected plugins stay listed even at
  // zero — a selection must never be stranded out of reach of its own checkbox.
  const pickerItems: PickerItem[] = React.useMemo(() => {
    const by = new Map<string, PickerItem>();
    for (const r of forType(assetsNoPlugin, pluginsNoPlugin)) {
      const key = pluginKey(r);
      const at = by.get(key);
      if (at) at.count++;
      else by.set(key, { key, name: r.plugin, marketplace: r.marketplace, count: 1 });
    }
    for (const key of pluginSel) {
      if (by.has(key)) continue;
      const [name, marketplace] = [key.slice(0, key.lastIndexOf("@")), key.slice(key.lastIndexOf("@") + 1)];
      by.set(key, { key, name, marketplace, count: 0 });
    }
    return [...by.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [assetsNoPlugin, pluginsNoPlugin, forType, pluginSel]);

  const togglePlugin = (key: string): void => {
    setPluginSel((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
    setSel(0);
  };
```

Render the picker at the end of the scope `.pills` row:

```tsx
          <PluginPicker
            items={pickerItems}
            selected={pluginSel}
            onToggle={togglePlugin}
            onClear={() => { setPluginSel([]); setSel(0); }}
          />
```

Replace the chip row with one that carries both dimensions and a clear-all:

```tsx
        {(cat || pluginSel.length > 0) && (
          <div className="chips">
            {cat && (
              <button type="button" className="chip" onClick={() => { setCat(null); setSel(0); }}>
                {categoryLabel(cat)} ×
              </button>
            )}
            {pluginSel.map((k) => (
              <button key={k} type="button" className="chip" onClick={() => togglePlugin(k)}>
                {k.slice(0, k.lastIndexOf("@"))} ×
              </button>
            ))}
            <button
              type="button"
              className="chip clear"
              onClick={() => { setCat(null); setPluginSel([]); setSel(0); }}
            >
              Clear
            </button>
          </div>
        )}
```

Make the plugin name in a row clickable — replace the `.meta` span in the row body:

```tsx
                          <button
                            type="button"
                            className="meta link"
                            onClick={(e) => { e.stopPropagation(); togglePlugin(pluginKey(r)); }}
                          >
                            {r.plugin}
                          </button>
                          {r.kind === "asset" && <span className="meta">· {r.marketplace}</span>}
```

- [ ] **Step 8: Style the picker and the clickable plugin name**

Append to `src/webview/marketplaceStyles.ts`:

```css
  .picker { position: relative; }
  .pop { position: absolute; z-index: 5; top: calc(100% + 5px); left: 0; width: 290px; padding: 8px;
    display: flex; flex-direction: column; gap: 7px; border-radius: 8px; border: 1px solid var(--hair);
    background: var(--vscode-editorWidget-background); box-shadow: 0 6px 20px rgba(0,0,0,.28); }
  .pq { padding: 5px 8px; border-radius: 6px; font-size: 12px; font-family: inherit;
    border: 1px solid var(--hair); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .pq:focus { outline: none; border-color: var(--vscode-focusBorder); }
  .plist { max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; }
  .pitem { display: flex; align-items: center; gap: 7px; padding: 4px 5px; border-radius: 5px;
    font-size: 12px; cursor: pointer; }
  .pitem:hover { background: var(--vscode-list-hoverBackground); }
  .pitem .pn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pitem .pm { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .pempty { padding: 10px 5px; font-size: 11.5px; color: var(--vscode-descriptionForeground); }
  .pclear { align-self: flex-start; }

  .row .meta.link { background: transparent; border: 0; padding: 0; font-family: inherit;
    font-size: 11.5px; cursor: pointer; color: var(--vscode-descriptionForeground); }
  .row .meta.link:hover { color: var(--vscode-textLink-foreground); text-decoration: underline; }
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run test/webview && npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/webview/PluginPicker.tsx src/webview/MarketplaceApp.tsx src/webview/marketplaceStyles.ts \
        test/webview/PluginPicker.test.tsx test/webview/MarketplaceApp.test.tsx
git commit -m "feat(marketplace): filter by several plugins at once"
```

---

### Task 8: Marketplace tags become filters

The tag row under the pills is currently the only inert control in the bar. Same chip mechanism, one more dimension.

**Files:**
- Modify: `src/webview/MarketplaceApp.tsx` (sift, `.srcs` row, chips)
- Modify: `src/webview/marketplaceStyles.ts:52-58`
- Test: `test/webview/MarketplaceApp.test.tsx`

**Interfaces:**
- Consumes: `Row.marketplace` from Task 6, `togglePlugin`/chip row from Task 7.
- Produces: `mktSel: string[]` state, matched against `Row.marketplace`.

- [ ] **Step 1: Write the failing test**

Append to `test/webview/MarketplaceApp.test.tsx`:

```ts
describe("MarketplaceApp marketplace filter", () => {
  const v = () => view({
    marketplaces: [
      { name: "atbay", kind: "github", origin: "org/atbay", pluginCount: 2, stale: false },
      { name: "~/.claude", kind: "user", origin: "~/.claude", pluginCount: 1, stale: false },
    ],
  });

  it("narrows to a marketplace when its tag is clicked", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(v()));
    fireEvent.click(screen.getByRole("button", { name: "~/.claude" }));
    expect(rowText("mine")).toBeInTheDocument();
    expect(screen.queryByText("pipeline")).not.toBeInTheDocument();
  });

  it("keeps several marketplaces at once and clears from the chip", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(v()));
    fireEvent.click(screen.getByRole("button", { name: "~/.claude" }));
    fireEvent.click(screen.getByRole("button", { name: "atbay" }));
    expect(screen.getAllByText("pipeline").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /atbay ×/ }));
    expect(screen.queryByText("pipeline")).not.toBeInTheDocument();
  });

  it("AND-s the marketplace with the plugin selection", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(v()));
    fireEvent.click(screen.getByRole("button", { name: "~/.claude" }));
    fireEvent.click(screen.getByRole("button", { name: /^Plugins ▾/ }));
    expect(screen.queryByLabelText("gc-plugin")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/webview/MarketplaceApp.test.tsx -t "marketplace filter"`
Expected: FAIL — the tags are `<span>`s, so no button matches `~/.claude`.

- [ ] **Step 3: Add the dimension**

Add state:

```ts
  const [mktSel, setMktSel] = React.useState<string[]>([]);
```

Add to `sift`, after the scope checks (no `skip` case — nothing counts against this dimension):

```ts
        if (mktSel.length && !mktSel.includes(r.marketplace)) continue;
```

and add `mktSel` to its dependency array.

Add the toggle beside `togglePlugin`:

```ts
  const toggleMkt = (name: string): void => {
    setMktSel((s) => (s.includes(name) ? s.filter((n) => n !== name) : [...s, name]));
    setSel(0);
  };
```

Turn the tags into buttons:

```tsx
            {view.marketplaces.map((m) => (
              <button
                key={`${m.name}:${m.origin}`}
                type="button"
                className={`tag${m.stale ? " bad" : ""}${mktSel.includes(m.name) ? " on" : ""}`}
                title={m.origin}
                onClick={() => toggleMkt(m.name)}
              >
                {m.stale ? `${m.name} — stale` : m.name}
              </button>
            ))}
```

Extend the chip row's condition and contents:

```tsx
        {(cat || pluginSel.length > 0 || mktSel.length > 0) && (
          <div className="chips">
            …
            {mktSel.map((n) => (
              <button key={n} type="button" className="chip" onClick={() => toggleMkt(n)}>
                {n} ×
              </button>
            ))}
            <button
              type="button"
              className="chip clear"
              onClick={() => { setCat(null); setPluginSel([]); setMktSel([]); setSel(0); }}
            >
              Clear
            </button>
          </div>
        )}
```

- [ ] **Step 4: Style the interactive tag**

In `src/webview/marketplaceStyles.ts`, after the existing `.tag` rules:

```css
  button.tag { cursor: pointer; font-family: inherit; background: transparent; }
  button.tag:hover { background: var(--vscode-toolbar-hoverBackground); }
  button.tag.on { border-color: var(--vscode-focusBorder);
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground); }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/webview && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/webview/MarketplaceApp.tsx src/webview/marketplaceStyles.ts test/webview/MarketplaceApp.test.tsx
git commit -m "feat(marketplace): make the marketplace tags a multi-select filter"
```

---

### Task 9: The file preview fills the detail pane

**Files:**
- Create: `src/webview/FilePreview.tsx`
- Modify: `src/webview/MarketplaceApp.tsx` (cache, request effect, detail pane)
- Modify: `src/webview/marketplaceStyles.ts:87-100`
- Test: `test/webview/FilePreview.test.tsx`, `test/webview/MarketplaceApp.test.tsx`

**Interfaces:**
- Consumes: `mkt:read` / `mkt:file` (Task 4), `<Markdown text />` (Task 5), `Row.readme` (Task 6).
- Produces: `<FilePreview file={string} cached={{ text: string; truncated: boolean } | undefined} fence={string} onOpen={() => void} />`. `fence` is a language tag: non-empty wraps the text in a fenced block (used for hooks' JSON); `""` renders it as markdown.

- [ ] **Step 1: Write the failing preview-component test**

Create `test/webview/FilePreview.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/webview/FilePreview.test.tsx`
Expected: FAIL — `Failed to resolve import "../../src/webview/FilePreview"`.

- [ ] **Step 3: Write the component**

Create `src/webview/FilePreview.tsx`:

```tsx
import * as React from "react";
import { Markdown } from "./Markdown";

/** The selected row's own file, rendered under its detail block. `fence` names a
 * language for content that isn't markdown — a hook's hooks.json, say. */
export function FilePreview({
  file,
  cached,
  fence,
  onOpen,
}: {
  file: string;
  cached: { text: string; truncated: boolean } | undefined;
  fence: string;
  onOpen: () => void;
}): JSX.Element {
  if (!file) return <div className="mdnone">Nothing to preview for this one.</div>;
  if (!cached) return <div className="mdnone">Loading…</div>;
  if (!cached.text.trim()) return <div className="mdnone">Nothing to preview for this one.</div>;
  const text = fence ? `\`\`\`${fence}\n${cached.text}\n\`\`\`` : cached.text;
  return (
    <div className="preview">
      <Markdown text={text} />
      {cached.truncated && (
        <div className="mdtrunc">
          Truncated at 256 KB.{" "}
          <button type="button" className="btn" onClick={onOpen}>
            Open file
          </button>{" "}
          for the rest.
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/webview/FilePreview.test.tsx`
Expected: PASS — 7 tests.

- [ ] **Step 5: Write the failing wiring test**

Append to `test/webview/MarketplaceApp.test.tsx`:

```ts
describe("MarketplaceApp file preview", () => {
  const reads = () => sent.mock.calls.map((c) => c[0]).filter((m: any) => m.type === "mkt:read");

  it("asks the host for the selected row's file exactly once", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    expect(reads()).toEqual([{ type: "mkt:read", file: "/u/skills/mine/SKILL.md" }]);
  });

  it("renders the file when it arrives", () => {
    const { container } = render(<MarketplaceApp />);
    host(assetsMsg());
    host({ type: "mkt:file", file: "/u/skills/mine/SKILL.md", text: "# Mine\n", truncated: false });
    expect(container.querySelector(".preview h1")).toHaveTextContent("Mine");
  });

  it("does not re-read a file already in the cache", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    host({ type: "mkt:file", file: "/u/skills/mine/SKILL.md", text: "# Mine\n", truncated: false });
    fireEvent.click(rowText("watch"));
    host({ type: "mkt:file", file: "/b/skills/watch/SKILL.md", text: "# Watch\n", truncated: false });
    sent.mockClear();
    fireEvent.click(rowText("mine"));
    expect(reads()).toEqual([]);
  });

  it("previews a plugin's README rather than a source file", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(view({ plugins: [plugin({ name: "cicd-plugin", readme: "/mk/cicd/README.md" })] })));
    sent.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Plugins\s*\d/ }));
    expect(reads()).toEqual([{ type: "mkt:read", file: "/mk/cicd/README.md" }]);
  });

  it("drops the cache on a rescan so an edited file reloads", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    host({ type: "mkt:file", file: "/u/skills/mine/SKILL.md", text: "# Mine\n", truncated: false });
    sent.mockClear();
    host(assetsMsg());
    expect(reads()).toEqual([{ type: "mkt:read", file: "/u/skills/mine/SKILL.md" }]);
  });

  it("keeps the detail block above the preview", () => {
    const { container } = render(<MarketplaceApp />);
    host(assetsMsg());
    expect(container.querySelector(".detail .dn")).toHaveTextContent("mine");
    expect(container.querySelector(".detail .mdnone")).toBeInTheDocument();
  });
});
```

Note: the `Plugins` type pill and the `Plugins ▾` picker button both start with "Plugins", hence the `/^Plugins\s*\d/` matcher for the pill.

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run test/webview/MarketplaceApp.test.tsx -t "file preview"`
Expected: FAIL — no `mkt:read` is ever sent.

- [ ] **Step 7: Wire the cache and the request**

Import and add state to `MarketplaceApp`:

```ts
import { FilePreview } from "./FilePreview";
```

```ts
const CACHE_MAX = 50; // bodies, not bytes — a rescan clears the lot anyway
```

```ts
  const [files, setFiles] = React.useState<Map<string, { text: string; truncated: boolean }>>(new Map());
  // Reads already in flight. Kept out of state so arrival doesn't re-trigger the
  // effect that asked for them.
  const asked = React.useRef(new Set<string>());
```

In the message handler effect, extend the branches:

```ts
      if (m.type === "mkt:assets") {
        setView(m.view);
        // A rescan may have found edited files; the old bodies are no longer true.
        setFiles(new Map());
        asked.current.clear();
      } else if (m.type === "mkt:file") {
        setFiles((prev) => {
          const next = new Map(prev);
          next.delete(m.file); // re-insert so Map order is least-recently-added first
          next.set(m.file, { text: m.text, truncated: m.truncated });
          while (next.size > CACHE_MAX) next.delete(next.keys().next().value as string);
          return next;
        });
      } else if (m.type === "mkt:loading") setLoading(m.loading);
```

After `active` is computed:

```ts
  // A plugin row has no source file of its own; its README is the closest thing.
  const previewFile = active ? (active.kind === "plugin" ? active.readme : active.file) : "";

  React.useEffect(() => {
    if (!previewFile || files.has(previewFile) || asked.current.has(previewFile)) return;
    asked.current.add(previewFile);
    send({ type: "mkt:read", file: previewFile });
  }, [previewFile, files]);
```

- [ ] **Step 8: Compact the detail block and mount the preview**

In the detail pane, drop the `dd`/`kv` verbosity into a tighter block and append the preview. Replace the `<dl className="kv">` … through the closing `</div>` of `.acts` with:

```tsx
              <div className="dd">{active.description || "No description in the frontmatter."}</div>
              <dl className="kv">
                <dt>Where</dt>
                <dd>{active.where}</dd>
                {active.rel && (
                  <>
                    <dt>File</dt>
                    <dd>{active.rel}</dd>
                  </>
                )}
              </dl>
              {active.copy && (
                <div className="snip">
                  <pre>{active.copy}</pre>
                  <button type="button" className="btn cp" onClick={() => send({ type: "mkt:copy", text: active.copy })}>
                    Copy
                  </button>
                </div>
              )}
              {active.file && (
                <div className="acts">
                  <button type="button" className="btn pri" onClick={() => send({ type: "mkt:open", file: active.file })}>
                    Open file
                  </button>
                  <button type="button" className="btn" onClick={() => send({ type: "mkt:reveal", file: active.file })}>
                    Reveal in Finder
                  </button>
                </div>
              )}
              <FilePreview
                file={previewFile}
                cached={files.get(previewFile)}
                fence={active.type === "hook" ? "json" : ""}
                onOpen={() => send({ type: "mkt:open", file: previewFile })}
              />
```

- [ ] **Step 9: Style the pane and the markdown body**

In `src/webview/marketplaceStyles.ts`, replace the `.detail` rule and append the markdown rules:

```css
  .detail { flex: 0 0 44%; min-width: 340px; overflow-y: auto; padding: 18px;
    display: flex; flex-direction: column; gap: 11px; }
  .detail .dh { display: flex; align-items: center; gap: 9px; }
  .detail .dn { font-size: 16px; font-weight: 600; word-break: break-word; }

  .preview, .mdnone { border-top: 1px solid var(--hair); padding-top: 13px; }
  .mdnone { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .mdtrunc { margin-top: 14px; font-size: 11.5px; color: var(--vscode-descriptionForeground); }

  .md { font-size: 12.5px; line-height: 1.55; }
  .md > *:first-child { margin-top: 0; }
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 16px 0 7px; line-height: 1.3; }
  .md h1 { font-size: 16px; }
  .md h2 { font-size: 14.5px; }
  .md h3 { font-size: 13px; }
  .md h4, .md h5, .md h6 { font-size: 12.5px; color: var(--vscode-descriptionForeground); }
  .md p, .md ul, .md ol, .md blockquote, .md pre, .md table { margin: 0 0 10px; }
  .md ul, .md ol { padding-left: 20px; }
  .md li { margin: 2px 0; }
  .md code { font-family: var(--mono); font-size: 11.5px; padding: 1px 4px; border-radius: 4px;
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.12)); }
  .md pre { overflow-x: auto; padding: 9px 11px; border-radius: 7px; border: 1px solid var(--hair);
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.1)); }
  .md pre code { padding: 0; background: none; }
  .md blockquote { padding-left: 11px; border-left: 2px solid var(--hair);
    color: var(--vscode-descriptionForeground); }
  .md hr { border: 0; border-top: 1px solid var(--hair); margin: 14px 0; }
  .md a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .md table { border-collapse: collapse; display: block; overflow-x: auto; font-size: 11.5px; }
  .md th, .md td { border: 1px solid var(--hair); padding: 4px 8px; text-align: left; }
  .md th { font-weight: 600; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.08)); }
```

- [ ] **Step 10: Run the full suite with coverage**

Run: `npm run test:cov && npm run typecheck && npm run build`
Expected: PASS, thresholds met, esbuild clean.

- [ ] **Step 11: Commit**

```bash
git add src/webview/FilePreview.tsx src/webview/MarketplaceApp.tsx src/webview/marketplaceStyles.ts \
        test/webview/FilePreview.test.tsx test/webview/MarketplaceApp.test.tsx
git commit -m "feat(marketplace): render the selected asset's file in the detail pane"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md:66-83`
- Modify: `CHANGELOG.md` (top)

- [ ] **Step 1: Update the README's Marketplace section**

Replace the paragraph beginning "Search is fuzzy and ranked" with:

```markdown
Search is fuzzy and ranked — `revw` finds `/review`, `mkpl` finds `marketplace` — with the
best match selected as you type and the type tallies following the query. When you aren't
searching, the list is grouped into **category sections** read from each plugin's own
manifest — Development, Monitoring, Deployment, and so on, with everything you wrote
yourself under **Yours** and plugins whose manifest omits the field under
**Uncategorized**. Click a section header to focus that category.

Narrow further by type, by what's installed or enabled, by **several plugins at once**
(the `Plugins ▾` picker, or click a plugin name in any row), and by marketplace (click its
tag). Every filter AND-s with the others, and the chips under the pills say what's active.

Selecting a row **renders its file** in the pane on the right, under the metadata — a
skill's `SKILL.md`, a hook's `hooks.json`, a plugin's README — so you can read what
something actually does without opening it. Files over 256 KB are truncated with a link
into the editor. The renderer builds elements from a parsed tree and never injects HTML,
so a hostile file in a third-party marketplace can't run anything.
```

- [ ] **Step 2: Add the CHANGELOG entry**

At the top of `CHANGELOG.md`, under a new `## Unreleased` heading (match the format of the entries already there):

```markdown
### Added

- **Marketplace category sections.** The browse list is grouped by each plugin's manifest
  `category` — Yours first, then by size, Uncategorized last. Click a header to focus it.
- **Multi-select plugin and marketplace filters.** A searchable `Plugins ▾` picker, plus
  click-a-name-in-a-row, with removable chips. All six filter dimensions AND together.
- **File preview in the detail pane.** The selected skill, command, agent, hook or plugin
  README renders as markdown under its metadata. Truncated at 256 KB.
```

- [ ] **Step 3: Verify and commit**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

```bash
git add README.md CHANGELOG.md
git commit -m "docs: describe the Marketplace's category sections, filters and file preview"
```

- [ ] **Step 4: Note for the merge**

This repo releases on merge to main: bump the version in `package.json`, run `npm run package` to build a fresh `.vsix`, and remove the stale one. Do that at merge time, not during implementation.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Data model — `category`, `readme`, synthetic buckets | 1 |
| Taxonomy from the manifest, lower-cased | 1 |
| Sections — order, no merging, labels | 2 |
| Grouping on any type filter, none while searching, none when focused | 6 |
| Section header counts exclude only category | 6 |
| Six AND-ed dimensions | 6, 7, 8 |
| Plugin picker — searchable, count-ordered, selected-stay-listed | 7 |
| Click a row's plugin name | 7 |
| Chip row, absent at rest, Clear | 6, 7, 8 |
| Marketplace tags clickable, multi-select | 8 |
| Type pill counts recompute | 6 (test), 7 (test) |
| Selection index resets on filter change | 6, 7, 8 (`setSel(0)` in every toggle) |
| Preview layout — detail on top, file below | 9 |
| `mkt:read` / `mkt:file`, allow-list, 262144 chars | 4 |
| Cache of 50, cleared on rescan, no duplicate reads | 9 |
| Loading placeholder | 9 |
| Per-kind source (md / hooks.json / README) | 9 |
| No `dangerouslySetInnerHTML`, subset, safe hrefs, escaped HTML | 3, 5 |
| Unreadable file → empty state, not a toast | 4 (host returns `""`), 9 (empty state) |
| Testing — engine, webview, host | 1–9 |

**Type consistency:** `Attribution.category` (Task 1) feeds `AssetView.category` (Task 1) → `Row.category` (Task 6) → `orderSections` (Task 2). `pluginKey(r)` is defined once in Task 7 and used by `sift`, `pickerItems`, the chip row and the row click. `PickerItem` is exported from `PluginPicker.tsx` (Task 7) and imported by `MarketplaceApp.tsx` in the same task. `Block`/`Inline` are exported from `markdown.ts` (Task 3) and consumed by `Markdown.tsx` (Task 5). `sift`'s `skip` parameter widens from `"category" | ""` (Task 6) to `"category" | "plugin" | ""` (Task 7) — Task 7 restates the whole function, so no stale signature survives.

**Placeholders:** none. Every code step carries the actual code; every test step carries the actual assertions.
