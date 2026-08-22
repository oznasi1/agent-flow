# Deck Session Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename every user-facing "agent" that means *a running Deck card* to "session", leaving identifiers, stored values and wire formats untouched, and add a test that keeps it that way.

**Architecture:** A display-layer rename guarded by a new gate test. The gate parses `src/**/*.ts(x)` with the TypeScript compiler API, collects string literals / template chunks / JSX text (never comments), and compares the agent-word hits against an explicit allowlist. The allowlist starts as a complete inventory of today's 110 hits and shrinks task by task — removing a file from it is what makes each task's test go red, and renaming that file's strings is what makes it green again. One task adds real logic: an `agentLabel` field on the Deck's `deck:runs` message so Deck copy can name the user's tool.

**Tech Stack:** TypeScript 5.4, React 18 webviews, Vitest (node + jsdom), esbuild, the TypeScript compiler API (already a devDependency) for the gate's parser.

**Spec:** [docs/superpowers/specs/2026-08-22-deck-session-semantics-design.md](../specs/2026-08-22-deck-session-semantics-design.md) — read it before Task 1. The vocabulary table and the "When may a string still say Claude Code?" test are the two sections you will consult repeatedly.

## Global Constraints

- **The vocabulary, verbatim from the spec.** **session** = one run of a coding tool, one Deck card, one row in `run.agents[]`. **agent** = a worker a session delegates to. *The tool's name* (Claude Code / Cursor / Copilot) = never called "the agent". Test for a new string: if it could be preceded by "one of the many things this session spawned", the word is *agent*; otherwise *session*.
- **Display layer only.** Never rename an identifier, a setting id, a stored enum value, an on-disk field, a telemetry wire value, or an orchestrator condition key. If a change would alter what is written to `~/.agentflow/` or read from a settings file, it is out of scope and the plan is wrong — stop and say so.
- **`test/unit/compat.test.ts` must pass completely unmodified.** Never edit it. It is the proof no user's settings, flows or run records moved. If it fails, revert and stop.
- **The existing suite changes only in display-string literals.** 22 assertions across 8 files match rendered copy. Changing the *literal* inside an assertion is expected. Changing an assertion's structure, its expected count, or which behaviour it checks is **the signal to stop and escalate** — do not "fix" a test to go green.
- **"Claude Code" stays only where it is load-bearing** — where the sentence would become false without it (Remote Control genuinely needs Claude Code; `~/.claude/sessions` genuinely is the only readable session registry). Where it stands in for "whichever tool you configured", it is a bug: use `agentLabel`.
- **CI gate, all four steps, in order:** `npm ci`, `npm run typecheck`, `npm test`, `npm run build`. All must pass. `npm run build` is a real gate — esbuild resolves statically, so a webview module that imports `fs`/`os`/`path`/`child_process` even transitively breaks the build while `tsc` and most of the suite still pass.
- **`npm test` is ~4,500 tests over ~2-4 minutes** and exceeds the default Bash tool timeout. Always pass `timeout: 600000`. **Never pipe vitest through `tail` or `head`** — it discards the failure list. A single failure under CPU contention is usually flake: re-run that one file alone before believing it.
- **Coverage thresholds** (`npm run test:cov`): 90% lines/statements, 85% branches/functions. `src/types.ts` and the stylesheet modules are already coverage-excluded, so type-only and CSS edits cost nothing. The `agentLabel` plumbing is new logic in `src/deckView.ts`, which *is* covered — it needs a test.
- **Commit after every task.** Work only in this worktree, on branch `worktree-deck-session-semantics`. Never `cd` to the main checkout; parallel sessions share it. Never use bare `git stash` — the stash stack is shared.
- **`main` moves fast** (several releases a day). Re-check `git log origin/main -1` at the start of each task; if it moved, rebase before continuing.

---

## File Structure

**Created:**
- `test/_helpers/userFacingStrings.ts` — the extractor. Parses a TS/TSX source with the compiler API and returns the user-facing strings it contains. Pure, no test assertions, no `describe`. Not collected as a test (vitest `include` is `test/**/*.test.{ts,tsx}`).
- `test/unit/vocabulary.test.ts` — the gate. Owns `LEGITIMATE` and `PENDING_LOCATIONS`, scans `src/` and `package.json`, asserts set equality.

**Modified (logic):**
- `src/types.ts` — one field on the `deck:runs` message.
- `src/deckView.ts` — send that field; plus 8 display strings.
- `src/webview/DeckApp.tsx` — hold that field; plus 8 strings (5 of which are wire values that must NOT change).

**Modified (display strings only):** `src/agentPick.ts`, `src/config.ts`, `src/engine/orchestrator/armability.ts`, `src/engine/orchestrator/conditions.ts`, `src/engine/runs.ts`, `src/engine/workspace.ts`, `src/tasksView.ts`, `src/webview/App.tsx`, `src/webview/ClosedStrip.tsx`, `src/webview/DeckDetail.tsx`, `src/webview/Notepad.tsx`, `src/webview/OrchestratorDrawer.tsx`, `src/webview/ReviewStrip.tsx`, `src/webview/deckParts.tsx`, `src/webview/deckSignal.ts`, `src/webview/orchestratorRule.ts`, `package.json`.

**Unmodified but scanned (all hits legitimate):** `src/engine/claudeAssets.ts`, `src/engine/diffView.ts`, `src/engine/orchestrator/evaluate.ts`, `src/modesNotice.ts`, `src/telemetry/notice.ts`, `src/webview/MarketplaceApp.tsx`.

**Excluded from the scan at file level:** `src/webview/styles.ts`, `deckStyles.ts`, `orchestratorStyles.ts`, `marketplaceStyles.ts`, `tokens.ts`. Each exports one template literal holding a whole CSS file; that string is code, not prose, and allowlisting it would mean a multi-kilobyte entry invalidated by any unrelated style edit. This is the same set `vitest.config.ts` excludes from coverage.

**Docs:** `README.md`, `docs/GUIDE.md`, `docs/SETTINGS.md`, `docs/TELEMETRY.md`, `docs/PRIVACY.md`, `docs/CONNECTORS.md`, `docs/FORGES.md`, `docs/ORCHESTRATOR_COMMANDS.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `CHANGELOG.md`. **Never touch `docs/superpowers/plans/` or `docs/superpowers/specs/`** — those are historical records.

---

### Task 1: The extractor and the gate, green on today's inventory

Builds the scanner and lands it passing against the *current* codebase. No strings are renamed here. The point is a trustworthy red-green signal for Tasks 2-9.

**Files:**
- Create: `test/_helpers/userFacingStrings.ts`
- Create: `test/unit/vocabulary.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `hasAgentWord(s: string): boolean`
  - `userFacingStrings(fileName: string, source: string): string[]`
  - `scanSources(root: string): Hit[]` where `interface Hit { location: string; text: string }`
  - `scanManifest(root: string): Hit[]`
  - `EXCLUDED_MODULES: readonly string[]`
  - From the test file: `LEGITIMATE: {location: string; text: string; why: string}[]` and `PENDING_LOCATIONS: string[]`.

- [ ] **Step 1: Write the failing test for the extractor's rules**

Create `test/unit/vocabulary.test.ts` with only this block for now. These seven cases are the whole contract — each one is a category of false positive or false negative that would otherwise poison the allowlist.

```ts
import { describe, expect, it } from "vitest";
import { hasAgentWord, userFacingStrings } from "../_helpers/userFacingStrings";

describe("the user-facing string extractor", () => {
  it("finds plain strings, template chunks and JSX text", () => {
    const src = `
      const a = "3 agents";
      const b = \`\${n} agents open\`;
      const c = <span>One agent</span>;
    `;
    expect(userFacingStrings("f.tsx", src)).toEqual(
      expect.arrayContaining(["3 agents", " agents open", "One agent"]),
    );
  });

  it("ignores comments — they are developer prose, not UI copy", () => {
    const src = `
      // this agent is not a string
      /* neither is this agent */
      /** @see the agent docs */
      const x = 1;
    `;
    expect(userFacingStrings("f.ts", src)).toEqual([]);
  });

  it("ignores module specifiers", () => {
    expect(userFacingStrings("f.ts", `import { p } from "./agentPick";`)).toEqual([]);
  });

  it("ignores string-literal types — those are wire values, not copy", () => {
    const src = `type G = "agents" | "workspaces"; let g: G = "agents";`;
    // The type positions are skipped; the *value* assignment is still reported,
    // because a value is indistinguishable from copy without reading intent.
    expect(userFacingStrings("f.ts", src)).toEqual(["agents"]);
  });

  it("ignores object keys but keeps object values", () => {
    const src = `const m = { "agent": "Agents" };`;
    expect(userFacingStrings("f.ts", src)).toEqual(["Agents"]);
  });

  it("strips the product name before matching", () => {
    expect(hasAgentWord("Agent Flow Deck is ready")).toBe(false);
    expect(hasAgentWord("Agent Flow Deck started an agent")).toBe(true);
  });

  it("matches the agent-word only on word boundaries", () => {
    expect(hasAgentWord("agentProvider")).toBe(false);
    expect(hasAgentWord("agent-flow-base")).toBe(true); // hyphen IS a boundary
    expect(hasAgentWord("3 Agents")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

```bash
npx vitest run test/unit/vocabulary.test.ts
```

Expected: FAIL — `Cannot find module '../_helpers/userFacingStrings'`. If it fails any other way, the test file itself is wrong; fix that before continuing.

- [ ] **Step 3: Implement the extractor**

Create `test/_helpers/userFacingStrings.ts`:

```ts
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/** One user-facing string containing the agent-word, and where it lives.
 * `location` is a file path or a `package.json#<json-path>` — deliberately NOT
 * a line number, so an unrelated edit above a string cannot invalidate the
 * allowlist. */
export interface Hit {
  location: string;
  text: string;
}

const AGENT_WORD = /\bagents?\b/i;

/** The product is "Agent Flow Deck". That "Agent" is a proper noun and is never
 * in scope, so strip the product name before looking for the common noun.
 * Without this, the product name alone accounts for most matches. */
const PRODUCT_NAME = /\bAgent Flow(?: Deck)?\b/g;

export const hasAgentWord = (s: string): boolean =>
  AGENT_WORD.test(s.replace(PRODUCT_NAME, ""));

/** Stylesheet modules each export ONE template literal holding a whole CSS
 * file. That string is code, not prose: its class names (`.c-agents`) and CSS
 * comments would land in the allowlist as multi-kilobyte entries that any
 * unrelated style edit invalidates. Same set vitest.config.ts excludes from
 * coverage. */
export const EXCLUDED_MODULES: readonly string[] = [
  "src/webview/styles.ts",
  "src/webview/deckStyles.ts",
  "src/webview/orchestratorStyles.ts",
  "src/webview/marketplaceStyles.ts",
  "src/webview/tokens.ts",
];

/** A string literal is NOT user-facing copy when it is a module specifier, sits
 * inside a type, or is an object/property key. Everything else — values, JSX
 * text, and each literal chunk of a template — is text a human may read.
 * Comments are never visited at all, which is the whole reason this uses the
 * compiler API instead of a regex. */
function isNotCopy(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
  if (ts.isImportTypeNode(p) || ts.isModuleDeclaration(p)) return true;
  if (ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p)) return true;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isPropertySignature(p) && p.name === node) return true;
  if (ts.isEnumMember(p) && p.name === node) return true;
  return false;
}

/** Every user-facing string in one source file that contains the agent-word,
 * whitespace-collapsed so a reflowed line does not change the allowlist. */
export function userFacingStrings(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const take = (text: string) => {
    if (hasAgentWord(text)) out.push(text.replace(/\s+/g, " ").trim());
  };
  const visit = (n: ts.Node): void => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !isNotCopy(n)) take(n.text);
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) take(n.text);
    else if (ts.isJsxText(n)) take(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (/\.tsx?$/.test(e.name)) acc.push(full);
  }
  return acc;
}

export function scanSources(root: string): Hit[] {
  const excluded = new Set(EXCLUDED_MODULES);
  const hits: Hit[] = [];
  for (const file of walk(path.join(root, "src")).sort()) {
    const location = path.relative(root, file).split(path.sep).join("/");
    if (excluded.has(location)) continue;
    for (const text of userFacingStrings(file, fs.readFileSync(file, "utf8"))) {
      hits.push({ location, text });
    }
  }
  return hits;
}

/** The manifest's user-visible prose: setting descriptions, enum descriptions,
 * command titles, view names. Located by JSON path, which is stable. */
export function scanManifest(root: string): Hit[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, any>;
  const c = pkg.contributes ?? {};
  const hits: Hit[] = [];
  const add = (jsonPath: string, text: unknown) => {
    if (typeof text === "string" && hasAgentWord(text)) {
      hits.push({ location: `package.json#${jsonPath}`, text: text.replace(/\s+/g, " ").trim() });
    }
  };
  for (const [key, v] of Object.entries<any>(c.configuration?.properties ?? {})) {
    for (const f of ["description", "markdownDescription", "deprecationMessage"]) add(`${key}.${f}`, v[f]);
    (v.enumDescriptions ?? []).forEach((d: unknown, i: number) => add(`${key}.enumDescriptions[${i}]`, d));
    (v.markdownEnumDescriptions ?? []).forEach((d: unknown, i: number) =>
      add(`${key}.markdownEnumDescriptions[${i}]`, d));
  }
  for (const cmd of c.commands ?? []) {
    add(`command:${cmd.command}.title`, cmd.title);
    add(`command:${cmd.command}.category`, cmd.category);
  }
  for (const [grp, views] of Object.entries<any>(c.views ?? {})) {
    for (const v of views) add(`view:${grp}/${v.id}.name`, v.name);
  }
  for (const vc of c.viewsContainers?.activitybar ?? []) add(`viewsContainer:${vc.id}.title`, vc.title);
  return hits;
}
```

- [ ] **Step 4: Run the extractor tests and confirm they pass**

```bash
npx vitest run test/unit/vocabulary.test.ts
```

Expected: PASS, 7 tests. If the string-literal-type case fails, check that `isNotCopy` sees `LiteralTypeNode` as the parent — that requires `setParentNodes: true` (the `true` argument to `createSourceFile`).

- [ ] **Step 5: Commit the extractor**

```bash
git add test/_helpers/userFacingStrings.ts test/unit/vocabulary.test.ts
git commit -m "test(vocabulary): extract user-facing strings via the TS AST

A regex cannot tell a string from a comment, and this codebase comments
heavily about agents. The compiler API never visits comments, so the
inventory it produces is small enough to allowlist by hand."
```

- [ ] **Step 6: Generate today's inventory**

Run this throwaway script to print the current hits grouped by location. You will paste its output into the gate as `PENDING_LOCATIONS`.

```bash
npx tsx -e '
import { scanSources, scanManifest } from "./test/_helpers/userFacingStrings";
const hits = [...scanSources("."), ...scanManifest(".")];
const byLoc = new Map<string, number>();
for (const h of hits) byLoc.set(h.location, (byLoc.get(h.location) ?? 0) + 1);
console.log([...byLoc.keys()].sort().map((l) => `  "${l}",`).join("\n"));
console.log("locations:", byLoc.size, "hits:", hits.length);
' 2>/dev/null || npx vitest run test/unit/vocabulary.test.ts -t "__inventory__"
```

If `tsx` is unavailable, add a temporary `it("__inventory__", ...)` to the test file that `console.log`s the same thing, run it, then delete it. Expected: **24 source locations plus 26 `package.json#…` locations; 110 hits total.** If your numbers differ, `main` has moved — that is fine, use *your* numbers, and note the delta in the commit message.

- [ ] **Step 7: Add the gate, seeded green**

Append to `test/unit/vocabulary.test.ts`:

```ts
import * as path from "path";
import { scanManifest, scanSources, type Hit } from "../_helpers/userFacingStrings";

const ROOT = path.join(__dirname, "../..");

/** Every place the agent-word is CORRECT, with the reason. This list is the
 * durable answer to "why does this still say agent here?" — a design artifact,
 * not test scaffolding. Grows as Tasks 2-9 classify each string. */
const LEGITIMATE: { location: string; text: string; why: string }[] = [];

/** Locations not yet converted. Shrinks to empty over Tasks 2-9; the final task
 * deletes this list and its assertion. A location listed here tolerates ANY
 * agent-word text inside it. */
const PENDING_LOCATIONS: string[] = [
  // paste the generated list from Step 6 here
];

const key = (h: { location: string; text: string }) => `${h.location} ${h.text}`;
const allHits = (): Hit[] => [...scanSources(ROOT), ...scanManifest(ROOT)];

describe("the vocabulary gate", () => {
  it("has no agent-word outside the allowlist", () => {
    const allowed = new Set(LEGITIMATE.map(key));
    const pending = new Set(PENDING_LOCATIONS);
    const unexpected = allHits()
      .filter((h) => !allowed.has(key(h)) && !pending.has(h.location))
      .map((h) => `${h.location}: ${JSON.stringify(h.text)}`);
    // A card is a session. If one of these is genuinely correct, add it to
    // LEGITIMATE with a reason; do not add it to PENDING_LOCATIONS.
    expect(unexpected).toEqual([]);
  });

  it("has no dead allowlist entry", () => {
    // Set equality, not subset: an entry that no longer matches anything is as
    // much a failure as an unexpected string. Without this, the allowlist rots
    // into a blanket suppression list.
    const live = new Set(allHits().map(key));
    expect(LEGITIMATE.filter((e) => !live.has(key(e))).map((e) => e.location)).toEqual([]);
  });

  it("has no dead pending entry", () => {
    // Forces PENDING_LOCATIONS to shrink as strings are converted, instead of
    // silently covering a file that no longer needs covering.
    const locations = new Set(allHits().map((h) => h.location));
    expect(PENDING_LOCATIONS.filter((l) => !locations.has(l))).toEqual([]);
  });

  it("states a reason for every allowlist entry", () => {
    expect(LEGITIMATE.filter((e) => e.why.trim().length < 10)).toEqual([]);
  });
});
```

- [ ] **Step 8: Run the gate and confirm it passes**

```bash
npx vitest run test/unit/vocabulary.test.ts
```

Expected: PASS, 11 tests. `LEGITIMATE` is empty and `PENDING_LOCATIONS` covers everything, so this is a green baseline.

- [ ] **Step 9: Mutation-check the gate before trusting it**

A gate that cannot fail is worse than no gate. Prove all three assertions bite:

```bash
# 1. unexpected string  → assertion 1 must fail
sed -i '' 's/"Recently closed"/"Recently closed agents"/' src/webview/ClosedStrip.tsx
npx vitest run test/unit/vocabulary.test.ts   # EXPECT: FAIL "has no agent-word outside the allowlist"
git checkout src/webview/ClosedStrip.tsx

# 2. dead pending entry → assertion 3 must fail
#    add a bogus location to PENDING_LOCATIONS, run, expect FAIL, then remove it.

# 3. dead legitimate entry → assertion 2 must fail
#    add {location:"src/config.ts", text:"no such string", why:"deliberate mutant"},
#    run, expect FAIL "has no dead allowlist entry", then remove it.
```

All three must fail as described, and the tree must be clean afterwards (`git status --short` empty). If any mutation passes, the gate is broken — fix it before Task 2.

- [ ] **Step 10: Commit the gate**

```bash
git add test/unit/vocabulary.test.ts
git commit -m "test(vocabulary): gate the agent-word behind a set-equality allowlist

Seeded green: LEGITIMATE is empty and PENDING_LOCATIONS covers all 110 of
today's hits. Each later task removes locations from PENDING, which turns
the gate red until that file's strings say session.

Mutation-checked: an unexpected string, a dead allowlist entry and a dead
pending entry each fail their own assertion."
```

---

### Task 2: `agentLabel` on the Deck's message

The only task with real logic. Everything downstream that names the user's tool depends on it, so it comes first.

**Files:**
- Modify: `src/types.ts` — the `deck:runs` payload
- Modify: `src/deckView.ts` — `refresh()`
- Modify: `src/webview/DeckApp.tsx` — state + fallback
- Test: `test/unit/deckView.test.ts`, `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: `providerLabel(p: AgentProvider): string` and `resolvedProvider(s: AgentProviderSetting): AgentProvider`, both exported from `src/config.ts` (lines 209 and 227).
- Produces: `agentLabel: string` on the `deck:runs` message, and an `agentLabel` value in `DeckApp`'s state that Tasks 4 and 5 read. Default when a message omits it: `"Claude Code"`.

- [ ] **Step 1: Write the failing test for the host side**

Add to `test/unit/deckView.test.ts`. Match the file's existing setup helpers rather than inventing new ones — open it and copy the pattern used by a neighbouring `deck:runs` test.

```ts
it("sends the resolved provider label on deck:runs so Deck copy can name the tool", async () => {
  // Arrange the view the same way the neighbouring deck:runs tests do, with
  // agentFlow.agentProvider set to "cursor".
  const msg = posted().find((m) => m.type === "deck:runs");
  expect(msg).toMatchObject({ agentLabel: "Cursor" });
});
```

- [ ] **Step 2: Write the failing test for the webview fallback**

Add to `test/webview/DeckApp.test.tsx`:

```tsx
it("falls back to Claude Code when deck:runs omits agentLabel", async () => {
  render(<DeckApp />);
  // Post a deck:runs WITHOUT agentLabel, the way an older host would.
  await waitFor(() => expect(screen.getByTitle(/One card per Claude Code session/)).toBeTruthy());
});
```

Note: this asserts the Task 5 tooltip. Until Task 5 lands, assert on whatever the tooltip currently is; the point of this test is the fallback path, not the copy. Use `waitFor`, never a bare tick — a `FileReader` can outlive `setTimeout(0)` and land its `postMessage` in the *next* test.

- [ ] **Step 3: Run both and confirm they fail**

```bash
npx vitest run test/unit/deckView.test.ts -t "resolved provider label"
npx vitest run test/webview/DeckApp.test.tsx -t "falls back to Claude Code"
```

Expected: FAIL — `agentLabel` is `undefined` on the message.

- [ ] **Step 4: Add the field to the message type**

In `src/types.ts`, in the `deck:runs` member, directly after `sourceLabel: string`:

```ts
      /** The configured tool's user-facing name — "Claude Code", "Cursor",
       * "Copilot" — so no Deck string has to hardcode which tool is driving.
       * Same field, same intent as `sourceLabel` above: the Deck is a separate
       * panel with its own outbound message, so it carries its own copy. */
      agentLabel: string }
```

Move the closing brace from `sourceLabel: string }` to this new line.

- [ ] **Step 5: Send it from the host**

In `src/deckView.ts`, in `refresh()`'s `this.post({ type: "deck:runs", … })`, after `sourceLabel: this.connector.info().label,`:

```ts
        // Read fresh on every post, like sourceLabel and showTokenTotal above:
        // agentProvider is a setting the user can flip mid-session, and the
        // board re-posts often enough that this is the whole of keeping it live.
        agentLabel: providerLabel(resolvedProvider(getConfig().agentProvider)),
```

Add `providerLabel` and `resolvedProvider` to the existing `from "./config"` import.

- [ ] **Step 6: Hold it in the webview**

In `src/webview/DeckApp.tsx`, add state beside the other `deck:runs`-fed values, mirroring `App.tsx:143`:

```tsx
  const [agentLabel, setAgentLabel] = React.useState(DEFAULT_AGENT_LABEL);
```

Define `const DEFAULT_AGENT_LABEL = "Claude Code";` at module scope, and in the `deck:runs` handler:

```tsx
        setAgentLabel(m.agentLabel ?? DEFAULT_AGENT_LABEL);
```

The `?? DEFAULT_AGENT_LABEL` is required, not defensive: an in-flight message posted before this build's host reloads has no such field.

- [ ] **Step 7: Run the two tests, then the whole affected files**

```bash
npx vitest run test/unit/deckView.test.ts
npx vitest run test/webview/DeckApp.test.tsx
```

Expected: PASS. Other tests in those files may fail if they assert the exact shape of `deck:runs` — if one does, add `agentLabel` to its expected object. That is a literal addition, not a structural change, and is allowed.

- [ ] **Step 8: Typecheck and build**

```bash
npm run typecheck && npm run build
```

Expected: both clean. `providerLabel` lives in `src/config.ts`, which is host-side — confirm you did **not** import it into any `src/webview/` module, or the build will break even though `tsc` passes.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/deckView.ts src/webview/DeckApp.tsx test/unit/deckView.test.ts test/webview/DeckApp.test.tsx
git commit -m "feat(deck): carry the tool's name on deck:runs

The Deck had no way to name the configured tool, so its review actions
said 'agent' to every user — including Cursor and Copilot users, whose
tool it never named. Additive and optional, mirroring sourceLabel."
```

---

### Task 3: Deck card counts and strips

**Files:**
- Modify: `src/webview/deckSignal.ts:96`, `src/webview/deckParts.tsx:131`, `src/webview/ClosedStrip.tsx:40`
- Test: `test/webview/deckSignal.test.ts`, `test/webview/deckParts.test.tsx` (if present), `test/webview/DeckApp.test.tsx`

- [ ] **Step 1: Remove the three locations from `PENDING_LOCATIONS`**

Delete these lines from `test/unit/vocabulary.test.ts`:

```
  "src/webview/ClosedStrip.tsx",
  "src/webview/deckParts.tsx",
  "src/webview/deckSignal.ts",
```

- [ ] **Step 2: Run the gate and confirm it goes red**

```bash
npx vitest run test/unit/vocabulary.test.ts
```

Expected: FAIL, listing exactly these four strings:
```
src/webview/ClosedStrip.tsx: "Runs that left the board — no agent, no pull request, nothing uncommitted"
src/webview/deckParts.tsx: "1 agent"
src/webview/deckParts.tsx: "agents"
src/webview/deckParts.tsx: "c-agents"
src/webview/deckSignal.ts: "agents"
```

- [ ] **Step 3: Apply the renames**

`src/webview/deckSignal.ts` — the run's card-count bit:

```ts
  else if (r.agents.length > 1) bits.push({ kind: "text", text: `${r.agents.length} sessions` });
```

Update the comment two lines above it too — it currently says "the RUN's agent count, not this card's — on the Agents lens `agent` is one session"; make it read "the RUN's session count, not this card's — on the Sessions lens a card is one session".

`src/webview/deckParts.tsx:131`:

```tsx
  const label = soloName ?? (agents.length === 1 ? "1 session" : `${agents.length} sessions`);
```

Update the comment above it: "A single session's label IS its name … Falling back to \"1 session\", or counting several (\"N sessions\"), is prose".

Leave `className="c-agents"` and the `title="Claude Code sessions open in this directory"` exactly as they are — the class name is a CSS identifier, and that tooltip's vendor name is load-bearing (the list is read from `~/.claude/sessions`).

`src/webview/ClosedStrip.tsx:40`:

```tsx
          title="Runs that left the board — no session, no pull request, nothing uncommitted">
```

- [ ] **Step 4: Add the CSS class to `LEGITIMATE`**

```ts
  { location: "src/webview/deckParts.tsx", text: "c-agents",
    why: "CSS class name, an identifier in the stylesheet — renaming it is a style change, not a copy change" },
```

- [ ] **Step 5: Run the gate and the affected webview tests**

```bash
npx vitest run test/unit/vocabulary.test.ts
npx vitest run test/webview
```

Expected: the gate PASSES. Some `test/webview` assertions on "1 agent" / "N agents" / the Recently-closed tooltip will fail — update the string literal in each. Do not change what any of them asserts.

- [ ] **Step 6: Commit**

```bash
git add src/webview/deckSignal.ts src/webview/deckParts.tsx src/webview/ClosedStrip.tsx test/unit/vocabulary.test.ts test/webview
git commit -m "refactor(deck): card counts and strips say session"
```

---

### Task 4: The review strip

Depends on Task 2's `agentLabel`.

**Files:**
- Modify: `src/webview/ReviewStrip.tsx` (lines 167, 169, 230, 233, 321, 371, 374), `src/webview/DeckApp.tsx` (pass the prop)
- Test: `test/webview/ReviewStrip.test.tsx`

- [ ] **Step 1: Remove `"src/webview/ReviewStrip.tsx"` from `PENDING_LOCATIONS`, run the gate, confirm red**

Expected FAIL listing: `"Review with agent"` (×2), `"▶ Review with agent"`, `"Load agent's review"`, `"agent reviews ready"`, `"with agents"`, `"with agent"`.

- [ ] **Step 2: Add the prop**

Add `agentLabel: string` to `ReviewStrip`'s props interface, and pass `agentLabel={agentLabel}` from `DeckApp.tsx` where `<ReviewStrip …>` is rendered.

- [ ] **Step 3: Apply the renames**

| line | before | after |
| --- | --- | --- |
| 167 | `aria-label="Review with agent"` | `aria-label={\`Review with ${agentLabel}\`}` |
| 169 | `? "Review with agent"` | `` ? `Review with ${agentLabel}` `` |
| 230 | `"▶ Review with agent"` | `` `▶ Review with ${agentLabel}` `` |
| 233 | `Load agent's review` | `Load the session's review` |
| 321 | `agent reviews ready` | `session reviews ready` |
| 371 | `` `…with agents` `` | `` `…with ${agentLabel}` `` |
| 374 | `…with agent` | `` …with ${agentLabel} `` |

The two accessible names at 167 and 371 must stay distinct — the file's own comments explain why (one accessible name for two on-screen actions makes a click land on the wrong one). Substituting the same `agentLabel` into both preserves the distinction, because 371 keeps its `Review the ${n} selected PR${…}` prefix. Verify by reading both rendered names side by side.

- [ ] **Step 4: Run the gate and the strip's tests**

```bash
npx vitest run test/unit/vocabulary.test.ts
npx vitest run test/webview/ReviewStrip.test.tsx
```

Expected: gate PASSES; 5 assertions in the strip's tests need their literal updated to `Review with Claude Code` (the tests' default `agentLabel`). If a test renders `ReviewStrip` directly, it must now pass `agentLabel="Claude Code"` — adding a required prop to a render call is allowed.

- [ ] **Step 5: Typecheck, build, commit**

```bash
npm run typecheck && npm run build
git add src/webview/ReviewStrip.tsx src/webview/DeckApp.tsx test/unit/vocabulary.test.ts test/webview/ReviewStrip.test.tsx
git commit -m "refactor(deck): the review strip names the configured tool

'Review with agent' becomes 'Review with Cursor' for a Cursor user."
```

---

### Task 5: The grouping toggle, the detail drawer, the notepad, the sidebar

**Files:**
- Modify: `src/webview/DeckApp.tsx` (686, 687, 690), `src/webview/DeckDetail.tsx` (85, 192, 197), `src/webview/Notepad.tsx:649`, `src/webview/App.tsx:535`
- Test: `test/webview/DeckApp.test.tsx`, `test/webview/App.test.tsx`

- [ ] **Step 1: Remove those four locations from `PENDING_LOCATIONS`, run the gate, confirm red**

Expected FAIL listing 8 strings, five of which are the bare `"agents"` wire value in `DeckApp.tsx`.

- [ ] **Step 2: Apply the `DeckApp.tsx` renames — display only**

```tsx
              title={g === "agents"
                ? `One card per ${agentLabel} session, with the repo, ticket and PR it belongs to`
                : "One card per launched task, with its sessions nested underneath"}
              onClick={() => { setGrouping(g); send({ type: "deck:setGrouping", grouping: g }); }}
            >
              {g === "agents" ? "Sessions" : "Workspaces"}
```

**Do not touch** `useState<"agents" | "workspaces">("agents")`, `grouping === "agents"`, or `(["agents", "workspaces"] as const)`. Those five are the value persisted to `agentFlow.deckGrouping` and read back by every existing install. Changing one is a compat break.

- [ ] **Step 3: Add the five wire values to `LEGITIMATE`**

```ts
  { location: "src/webview/DeckApp.tsx", text: "agents",
    why: "the value persisted to agentFlow.deckGrouping and read back by every existing install — the UI label beside it says Sessions" },
```

One entry covers all five occurrences: the allowlist is keyed by location and text, and identical text in one file collapses to a single entry.

- [ ] **Step 4: Apply the remaining renames**

| file:line | before | after |
| --- | --- | --- |
| `DeckDetail.tsx:85` | `seed an agent against the review` | `start a session against the review` |
| `DeckDetail.tsx:192` | `<div className="dd-lbl">Agents</div>` | `…>Sessions</div>` |
| `DeckDetail.tsx:197` | `No agent open — git + {sourceLabel} only` | `No session open — git + {sourceLabel} only` |
| `Notepad.tsx:649` | `Start this note as an agent run` | `Start this note as a session` |
| `App.tsx:535` | `` `Explore repos with a ${agentLabel} agent — pick repos, no ticket needed` `` | `` `Explore repos in a ${agentLabel} session — pick repos, no ticket needed` `` |

`App.tsx` already has `agentLabel` in scope (line 143) — no plumbing needed there.

- [ ] **Step 5: Run the gate, the webview suite, then typecheck and build**

```bash
npx vitest run test/unit/vocabulary.test.ts
npx vitest run test/webview
npm run typecheck && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/DeckDetail.tsx src/webview/Notepad.tsx src/webview/App.tsx test/unit/vocabulary.test.ts test/webview
git commit -m "refactor(deck): the grouping lens is Sessions, not Agents

The stored value stays \"agents\" — only the label and the tooltips change.
The tooltip also stops claiming every card is Claude Code."
```

---

### Task 6: The orchestrator

Two copies of the same condition→label map exist — one host-side, one in the webview. Both must change identically, and neither key may move.

**Files:**
- Modify: `src/engine/orchestrator/armability.ts:63-65`, `src/engine/orchestrator/conditions.ts:235,240,251`, `src/webview/orchestratorRule.ts:43-45`, `src/webview/OrchestratorDrawer.tsx:1319,1334`
- Test: `test/unit/engine/orchestrator/conditions.test.ts`, `test/webview/OrchestratorDrawer.test.tsx`, `test/webview/flowList.test.tsx`

- [ ] **Step 1: Remove those four locations from `PENDING_LOCATIONS`, run the gate, confirm red**

- [ ] **Step 2: Rename the labels in BOTH maps, keys untouched**

Identical edit in `src/engine/orchestrator/armability.ts` and `src/webview/orchestratorRule.ts`:

```ts
  "agent-ended-turn": "session ended its turn",
  "agent-idle-over": "session idle over…",
  "no-agent-left": "no sessions left",
```

The keys `"agent-ended-turn"`, `"agent-idle-over"`, `"no-agent-left"` are serialized into flow files under `~/.agentflow/flows` and shared across windows. Renaming one silently breaks every saved flow.

- [ ] **Step 3: Rename the condition readouts in `conditions.ts`**

```ts
    case "agent-ended-turn": {
      const a = placeActivity(c);
      if (a.state === "unknown") return "session state unknown";
      return a.state === "needs-you" ? "ended turn" : a.state;
    }
    case "agent-idle-over": {
      const a = placeActivity(c);
      if (a.state === "unknown") return "session state unknown";
```

and:

```ts
    case "no-agent-left": {
      const n = agentsHere(c).length;
      return n === 0 ? "no sessions" : n === 1 ? "1 session open" : `${n} sessions open`;
    }
```

- [ ] **Step 4: Rename the drawer's copy**

| file:line | before | after |
| --- | --- | --- |
| `OrchestratorDrawer.tsx:1319` | `<span className="t">Agents</span>` | `…>Sessions</span>` |
| `OrchestratorDrawer.tsx:1334` | `Drag a card from the board to attach an agent.` | `Drag a card from the board to attach a session.` |

- [ ] **Step 5: Check whether `evaluate.ts:176`'s reason code is rendered**

`src/engine/orchestrator/evaluate.ts:176` calls `note(from.id, "agent-state-unknown")`. Find where those notes surface. **If the drawer renders the code raw, it is display text** and needs a label — add `"agent-state-unknown": "session state unknown"` to whichever map renders it, keeping the code itself unchanged. **If it is only a diagnostic**, add it to `LEGITIMATE`:

```ts
  { location: "src/engine/orchestrator/evaluate.ts", text: "agent-state-unknown",
    why: "a blocked-reason code recorded for diagnostics, not rendered to the user" },
```

Do not guess — read the call site of `note()` and follow the value.

- [ ] **Step 6: Add the condition keys to `LEGITIMATE`**

```ts
  { location: "src/engine/orchestrator/armability.ts", text: "agent-ended-turn",
    why: "condition key serialized into ~/.agentflow/flows — renaming it breaks every saved flow" },
  { location: "src/engine/orchestrator/armability.ts", text: "agent-idle-over", why: "condition key, as above" },
  { location: "src/engine/orchestrator/conditions.ts", text: "agent-ended-turn", why: "condition key, as above" },
  { location: "src/engine/orchestrator/conditions.ts", text: "agent-idle-over", why: "condition key, as above" },
  { location: "src/engine/orchestrator/conditions.ts", text: "no-agent-left", why: "condition key, as above" },
  { location: "src/engine/orchestrator/evaluate.ts", text: "agent-ended-turn", why: "condition key, as above" },
  { location: "src/engine/orchestrator/evaluate.ts", text: "agent-idle-over", why: "condition key, as above" },
  { location: "src/webview/orchestratorRule.ts", text: "agent-ended-turn", why: "condition key, as above" },
  { location: "src/webview/orchestratorRule.ts", text: "agent-idle-over", why: "condition key, as above" },
  { location: "src/webview/orchestratorRule.ts", text: "no-agent-left", why: "condition key, as above" },
```

`armability.ts` has `no-agent-left` in its label map too — add it if the gate reports it.

- [ ] **Step 7: Document the key/label mismatch where the keys live**

On the `Condition` type in `src/engine/orchestrator/model.ts`, add:

```ts
/** The `kind` strings below are serialized into flow files under
 * ~/.agentflow/flows and shared across windows, so they keep their released
 * spelling — `agent-idle-over`, not `session-idle-over` — while the labels
 * rendered beside them read "session". That mismatch is deliberate: a card is a
 * session in the UI, and renaming a key would break every saved flow. */
```

Without this the next contributor reads `agent-idle-over` as a missed rename and "fixes" it.

- [ ] **Step 8: Prove a saved flow still loads**

```bash
npx vitest run test/unit/engine/orchestrator
```

Expected: PASS. Any test that constructs an edge with `kind: "agent-idle-over"` must still pass **unmodified** — that is the compat proof for this task. If one needed editing, a key moved: revert and redo Step 2.

- [ ] **Step 9: Run the gate, the full orchestrator and webview suites, typecheck, build, commit**

```bash
npx vitest run test/unit/vocabulary.test.ts
npx vitest run test/unit/engine/orchestrator test/webview/OrchestratorDrawer.test.tsx test/webview/flowList.test.tsx
npm run typecheck && npm run build
git add src/engine/orchestrator src/webview/orchestratorRule.ts src/webview/OrchestratorDrawer.tsx test/unit/vocabulary.test.ts test/unit test/webview
git commit -m "refactor(orchestrator): rule labels say session, keys unchanged

Both copies of the condition→label map move together. The keys stay as
released because they are serialized into ~/.agentflow/flows, and the
Condition type now says so."
```

---

### Task 7: Host-side strings

**Files:**
- Modify: `src/agentPick.ts:35,36`, `src/config.ts:101`, `src/deckView.ts` (1101, 1123, 1378, 1382, 2136, 2152, 2324), `src/engine/runs.ts:75`, `src/engine/workspace.ts:411`, `src/tasksView.ts:2113,2209`
- Test: `test/unit/engine/runs.test.ts`, `test/unit/tasksView.test.ts`, `test/unit/deckView.test.ts`, `test/unit/engine/workspace.test.ts`

- [ ] **Step 1: Remove those six locations from `PENDING_LOCATIONS`, run the gate, confirm red**

- [ ] **Step 2: Apply the renames**

These are quick-pick prompts and notifications. Per the vocabulary, the *picker* chooses a tool; the *thing started* is a session.

| file:line | before | after |
| --- | --- | --- |
| `agentPick.ts:35` | `Which agent?` | `Which tool?` |
| `agentPick.ts:36` | `Pick the agent for every task in this batch` | `Pick the tool for every session in this batch` |
| `agentPick.ts:36` | `Pick the agent to start this session with` | `Pick the tool to start this session with` |
| `workspace.ts:411` | `Which agent?` / `Pick the agent to start this session with` | same as above |
| `config.ts:101` | `still has an agent attached, is at {brief}.` | `still has a session attached, is at {brief}.` |
| `deckView.ts:1101` | `It will still ask before it starts an agent session.` | `It will still ask before it starts a session.` |
| `deckView.ts:1123` | `is ready to seed another agent into` | `is ready to start another session in` |
| `deckView.ts:1378` | `seeded another agent in` | `started another session in` |
| `deckView.ts:1382` | `: seeded another agent in` | `: started another session in` |
| `deckView.ts:2136` | `PRs with agents? That's` … `agent sessions.` | `PRs with sessions? That's` … `sessions.` |
| `deckView.ts:2152` | `with agents` | `with sessions` |
| `deckView.ts:2324` | `Couldn't read the agent's review for` | `Couldn't read the session's review for` |
| `runs.ts:75` | `"agent open" : "idle, no agent attached"` | `"session open" : "idle, no session attached"` |
| `tasksView.ts:2113` | `— how should the agent start?` | `— how should the session start?` |
| `tasksView.ts:2209` | `selected task(s) — how should the agents start?` | `selected task(s) — how should the sessions start?` |

`config.ts:101` is a **prompt template seeded to the tool**, and `runs.ts:75` is the markdown brief that prompt reads. They must stay consistent with each other: the brief now says "session open", so the prompt must ask about sessions.

- [ ] **Step 3: Add the remaining host wire values to `LEGITIMATE`**

```ts
  { location: "src/config.ts", text: "agents",
    why: "the agentFlow.deckGrouping value normalized here — the stored setting, not copy" },
  { location: "src/engine/workspace.ts", text: "cursor-agent",
    why: "the name of Cursor's CLI binary" },
  { location: "src/engine/workspace.ts", text: "agent",
    why: "the chat `mode` argument passed to the editor's own open-chat command" },
  { location: "src/engine/claudeAssets.ts", text: "agents",
    why: "the `.claude/agents` directory name on disk" },
  { location: "src/engine/claudeAssets.ts", text: "agent",
    why: "the AssetType wire value for a subagent" },
  { location: "src/engine/claudeAssets.ts", text: "Skills, commands, agents and hooks outside any plugin.",
    why: "agents in the vocabulary's own sense — subagents a session delegates to" },
  { location: "src/engine/diffView.ts", text: "agent-flow-base",
    why: "a git ref name" },
  { location: "src/modesNotice.ts", text: "https://github.com/oznasi1/agent-flow/blob/main/CHANGELOG.md",
    why: "the repository URL" },
  { location: "src/telemetry/notice.ts", text: "https://github.com/oznasi1/agent-flow/blob/main/docs/TELEMETRY.md",
    why: "the repository URL" },
  { location: "src/tasksView.ts", text: "e.g. the deck-agents-view task",
    why: "an example branch name in a placeholder, not the noun" },
  { location: "src/webview/MarketplaceApp.tsx", text: "agent",
    why: "the AssetType wire value for a subagent" },
  { location: "src/webview/MarketplaceApp.tsx", text: "Agents",
    why: "the Marketplace tab listing subagents — the one correct use of the word" },
  { location: "src/webview/MarketplaceApp.tsx", text: "Search skills, commands, agents, hooks…",
    why: "searches subagents among the other asset types" },
```

Then remove `src/engine/claudeAssets.ts`, `src/engine/diffView.ts`, `src/modesNotice.ts`, `src/telemetry/notice.ts` and `src/webview/MarketplaceApp.tsx` from `PENDING_LOCATIONS` — nothing in them changes, so they graduate straight to `LEGITIMATE`.

- [ ] **Step 4: Run the gate, then the host suites**

```bash
npx vitest run test/unit/vocabulary.test.ts
npx vitest run test/unit
```

Expected: gate PASSES. Assertions in `runs.test.ts` (2), `deckView.test.ts` (1) and `doctor.test.ts` (1) need their literals updated.

- [ ] **Step 5: Typecheck, build, commit**

```bash
npm run typecheck && npm run build
git add src test/unit
git commit -m "refactor(host): notifications and pickers say session

The picker chooses a tool; the thing it starts is a session. The
supervision prompt template and the brief it reads move together."
```

---

### Task 8: The manifest

26 setting and enum descriptions. **No setting id, no enum value, and no command id changes** — `compat.test.ts` freezes the command list and three setting ids, and every id is read from users' existing `settings.json`.

**Files:**
- Modify: `package.json` (`contributes.configuration.properties`)
- Test: `test/unit/vocabulary.test.ts`, `test/unit/compat.test.ts` (must pass unmodified)

- [ ] **Step 1: Remove every `package.json#…` location from `PENDING_LOCATIONS`, run the gate, confirm red with 26 entries**

- [ ] **Step 2: Apply the renames**

| setting | change |
| --- | --- |
| `seedAgent.description` | "pre-fill the agent's panel (or terminal)" → "pre-fill the session's panel (or terminal)"; "Which agent is `agentFlow.agentProvider`" → "Which tool is `agentFlow.agentProvider`" |
| `agentProvider.markdownDescription` | "Which agent Agent Flow starts a session with." → "Which tool Agent Flow starts a session with." Keep the sentence about `copilot`/`cursor` falling back to Claude Code — load-bearing. |
| `agentProvider.enumDescriptions[3]` | "pick from the agents this editor can run" → "pick from the tools this editor can run" |
| `agentSurface.description` | "the agent's chat panel" → "the tool's chat panel" |
| `agentSurface.enumDescriptions[0]` | "The agent's chat panel" → "The tool's chat panel" |
| `agentSurface.enumDescriptions[1]` | "The agent's CLI in an integrated terminal" → "The tool's CLI in an integrated terminal" |
| `exploreSlackDm.markdownDescription` | "asks the agent to send you a Slack DM" → "asks the session to send you a Slack DM"; "(The agent does this via its own S…" → "(The session does this…" |
| `prReviewStatus.description` | rewrite the "agent" mention per the vocabulary table |
| `prReviewAutoFix.description` | "After the PR-review agent assesses the PR" → "After the PR-review session assesses the PR" |
| `prReviewPrompt.markdownDescription` | "The agent locates the task's GitHub PR" → "The session locates the task's GitHub PR" |
| `batchLaunchConfirmThreshold.markdownDescription` | rewrite the "agent" mention per the vocabulary table |
| `openAgents.markdownDescription` | "as agents on the card that owns their directory" → "as sessions on the card that owns their directory". **Keep** the opening "every Claude Code session open on this machine" — load-bearing, `~/.claude/sessions` is the only readable registry. |
| `deckGrouping.markdownDescription` | "**Agents / Workspaces** control" → "**Sessions / Workspaces** control" |
| `deckGrouping.enumDescriptions[0]` | "One card per Claude Code agent, with the repo, ticket and PR it belongs to on the card" → "One card per session, with the repo, ticket and PR it belongs to on the card". The vendor name is dropped rather than interpolated: manifest prose has no `agentLabel`, and naming one tool there is false for the others. |
| `deckGrouping.enumDescriptions[1]` | "with every agent open in its directories nested underneath" → "with every session open in its directories nested underneath" |
| `retireFinishedAfterHours` | "after its last agent closes" → "after its last session closes" |
| `retireClosedAfterHours` | "no agent of its own open" → "no session of its own open" |
| `retireInPlaceAfterHours` | "once you close its agent" → "once you close its session" |
| `orchestrator.markdownDescription` | "wire the agents already on your board" → "wire the sessions already on your board" |
| `reviewRequestModes`, `reviewRequestMode`, `reviewOpenIn`, `reviewRequestPrompt` | "**Review with agent**" → "**Review with your agent tool**" in all four; `reviewOpenIn.enumDescriptions[1]` "Ask each time you click Review with agent" → "…click Review with your agent tool" |
| `stampLabelOnWrite.description`, `telemetry.enabled.markdownDescription` | rewrite the "agent" mention per the vocabulary table |

For the four rows marked "rewrite … per the vocabulary table", read the current text and decide: a running card → session; the tool → name it or say "tool"; a subagent → leave it. State your choice in the commit message.

- [ ] **Step 3: Run the gate, then compat, then the whole suite**

```bash
npx vitest run test/unit/vocabulary.test.ts
npx vitest run test/unit/compat.test.ts
```

Expected: gate PASSES with zero manifest entries left (or a small `LEGITIMATE` set, if any description legitimately mentions subagents — add it with a reason). **`compat.test.ts` must pass with no edits.** If it fails, you changed an id: revert.

- [ ] **Step 4: Confirm the manifest is still valid JSON and the extension still packages**

```bash
node -e 'JSON.parse(require("fs").readFileSync("package.json","utf8")); console.log("valid")'
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add package.json test/unit/vocabulary.test.ts
git commit -m "docs(settings): setting descriptions say session

Ids and enum values are untouched, so agentFlow.openAgents now describes
sessions. Deliberate — recorded in the vocabulary gate's allowlist."
```

---

### Task 9: Docs, changelog, and the note that makes it stick

**Files:**
- Modify: `README.md`, `docs/GUIDE.md`, `docs/SETTINGS.md`, `docs/TELEMETRY.md`, `docs/PRIVACY.md`, `docs/CONNECTORS.md`, `docs/FORGES.md`, `docs/ORCHESTRATOR_COMMANDS.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `CHANGELOG.md`
- Test: `test/unit/docs.test.ts`

**Never touch `docs/superpowers/plans/` or `docs/superpowers/specs/`.**

- [ ] **Step 1: Find every mention**

```bash
grep -rnE '\bagents?\b' -i README.md CONTRIBUTING.md CLAUDE.md docs/*.md | grep -v 'Agent Flow'
```

Roughly 110 hits. Work file by file, applying the vocabulary table. A mention of `.claude/agents/`, of a subagent, or of the Marketplace's Agents tab stays.

- [ ] **Step 2: `docs/ORCHESTRATOR_COMMANDS.md` — labels change, and add the mismatch note**

| line | before | after |
| --- | --- | --- |
| 28 | `Opens a new agent session — real money` | `Opens a new session — real money` |
| 46 | `cleanliness, agent activity, ticket status` | `cleanliness, session activity, ticket status` |
| 53 | `covers launching and seeding agent sessions` | `covers launching and seeding sessions` |
| 199 | `` Same for `agent idle over…` `` | `` Same for `session idle over…` `` |

Then add, near the conditions section:

> Condition **keys** keep their released spelling — `agent-ended-turn`,
> `agent-idle-over`, `no-agent-left` — because they are serialized into flow
> files under `~/.agentflow/flows`. The labels shown beside them read
> "session". That mismatch is deliberate; renaming a key breaks every saved flow.

- [ ] **Step 3: Add the vocabulary note to `CONTRIBUTING.md` and `CLAUDE.md`**

The same short block in both, so the convention is inherited rather than rediscovered:

> **Vocabulary.** A **session** is one run of a coding tool — one Deck card, one
> row in `run.agents[]`. An **agent** is a worker a session delegates to (the
> Marketplace's Agents tab, `.claude/agents/`). The tool itself is named
> — "Review with Claude Code" — never called "the agent". Identifiers, setting
> ids, stored values and orchestrator condition keys keep their released
> spelling, so the code says `agents` where the UI says sessions.
> `test/unit/vocabulary.test.ts` enforces this; its allowlist records every
> place "agent" is still correct.

- [ ] **Step 4: Add the `CHANGELOG.md` entry under `## [Unreleased]`**

```markdown
### Changed
- The Deck calls a card a **session**, not an agent — a session is one run of your
  coding tool, and it can dispatch many agents (subagents) of its own. The
  `Agents / Workspaces` lens is now `Sessions / Workspaces`, and the review
  actions name your configured tool ("Review with Cursor") instead of saying
  "agent". No setting, saved flow or run record changes: `agentFlow.openAgents`,
  `agentFlow.deckGrouping`'s stored value and every orchestrator condition key
  keep their existing spelling.
```

- [ ] **Step 5: Run the docs test and the full suite**

```bash
npx vitest run test/unit/docs.test.ts
```

`docs.test.ts` asserts a changelog entry exists for new settings and that each connector/forge is documented. If a renamed phrase breaks one of its `toContain`/`toMatch` checks, update that literal. Consider adding one assertion that both `CONTRIBUTING.md` and `CLAUDE.md` contain the vocabulary note, so it cannot be dropped later.

- [ ] **Step 6: Commit**

```bash
git add README.md CONTRIBUTING.md CLAUDE.md docs CHANGELOG.md test/unit/docs.test.ts
git commit -m "docs: a card is a session

Also states, where the condition keys are documented, that their
agent- spelling is deliberate and must not be 'fixed'."
```

---

### Task 10: Close the gate and verify the whole thing

**Files:**
- Modify: `test/unit/vocabulary.test.ts` (delete `PENDING_LOCATIONS` and its assertion)

- [ ] **Step 1: Confirm `PENDING_LOCATIONS` is empty**

```bash
grep -A3 'PENDING_LOCATIONS: string\[\]' test/unit/vocabulary.test.ts
```

Expected: an empty array. If anything remains, that task is unfinished — go back and finish it. **Never** close the gate over a non-empty pending list.

- [ ] **Step 2: Delete the scaffolding**

Remove `PENDING_LOCATIONS`, the `pending` set and its filter clause in assertion 1, and the whole `"has no dead pending entry"` test. `LEGITIMATE` is now the permanent allowlist. Add a file-header comment:

```ts
/** The vocabulary gate. A Deck card is a "session"; an "agent" is a worker a
 * session delegates to; the tool is named, never called "the agent". Every
 * user-facing string in src/ and package.json is scanned, and every surviving
 * agent-word must be in LEGITIMATE with a stated reason. Set equality both
 * ways: an unexpected string fails, and so does a dead allowlist entry — which
 * is what stops this list rotting into a blanket suppression list.
 * See docs/superpowers/specs/2026-08-22-deck-session-semantics-design.md. */
```

- [ ] **Step 3: Re-run the mutation check on the closed gate**

```bash
sed -i '' 's/>Sessions</>Agents</' src/webview/DeckDetail.tsx
npx vitest run test/unit/vocabulary.test.ts   # EXPECT: FAIL, naming DeckDetail.tsx
git checkout src/webview/DeckDetail.tsx
git status --short                            # EXPECT: empty
```

If that passes, the closed gate is inert — fix it before continuing.

- [ ] **Step 4: Run the full CI gate, in order, exactly as CI does**

```bash
npm run typecheck
npm test          # pass timeout: 600000 — this takes 2-4 minutes and MUST NOT be piped through tail
npm run build
```

All three must pass. Read the real exit code of each — a wrapper's `echo` can mask a `SIGTERM`. On a single failure under CPU contention, re-run that one file alone before treating it as a regression.

- [ ] **Step 5: Confirm the compat surface never moved**

```bash
git diff main --stat -- test/unit/compat.test.ts
git diff main -- package.json | grep -E '^[-+].*"(agentFlow\.[A-Za-z]+|command)"' | sort
```

Expected: **no diff at all** in `compat.test.ts`, and no removed/added setting or command *ids* in `package.json` — only description text. If either shows otherwise, stop and report.

- [ ] **Step 6: Confirm only literals changed in the existing tests**

```bash
git diff main --stat -- test/
```

Review every test-file hunk. Each must be a string literal swap, an added `agentLabel` field, or an added required prop. **Any changed expectation, count, or assertion structure is the stop signal** — report it instead of shipping it.

- [ ] **Step 7: Coverage**

```bash
npm run test:cov
```

Expected: thresholds hold (90% lines/statements, 85% branches/functions). The only new logic is Task 2's `agentLabel`, covered by its two tests.

- [ ] **Step 8: Manual check in a real editor window**

`npm run build`, then launch the dev host with **VS Code's own** `code --extensionDevelopmentPath=…` (the Cursor CLI silently drops that flag), or press F5. Confirm:

1. The In-flight board's lens control reads **Sessions / Workspaces**.
2. Clicking `Sessions` then reloading the window keeps the lens — proving the stored value still round-trips as `"agents"`.
3. With `agentFlow.agentProvider` set to `cursor`, the review strip reads **Review with Cursor**.
4. A card with several open sessions reads "N sessions", and its nested tooltip still says "Claude Code sessions open in this directory".
5. An existing flow file containing `agent-idle-over` still loads, and its rule reads "session idle over…".

Item 5 is the compat proof no test can give you: it needs a real `~/.agentflow/flows` file written by an earlier build.

- [ ] **Step 9: Commit and report**

```bash
git add test/unit/vocabulary.test.ts
git commit -m "test(vocabulary): close the gate

PENDING_LOCATIONS is empty and gone. LEGITIMATE is now the permanent
record of every place the agent-word is still correct, each with a reason.
Mutation-checked against the closed gate."
```

Report: the four CI commands and their real exit codes; the `compat.test.ts` diff (must be empty); a one-line summary of every test-file hunk; and the results of all five manual checks. Do not claim completion without the manual-check results — items 2 and 5 are the only evidence that nothing on disk moved.

---

## Self-Review

**Spec coverage.** Spec §1 → Task 2. §2 → Tasks 3, 4, 5. §3 → Task 6. §4 → Task 5 (sidebar/notepad) and Task 7 (Marketplace's allowlist entries). §5 → Task 8. §6 → Task 7. §7 → Task 9. "The gate" → Tasks 1 and 10. "Verification" → Task 10. "When may a string still say Claude Code?" → the load-bearing/stand-in split is applied in Tasks 3, 5 and 8. "Explicitly out of scope" → the `LEGITIMATE` entries added in Tasks 3, 5, 6 and 7. No spec section is unimplemented.

**Corrections this plan makes to the spec.** The spec cites `OrchestratorDrawer.tsx:250, 254, 509` as display strings; the AST scan shows all three are **comments**. The drawer's real strings are `:1319` and `:1334`, and "agent state unknown" lives host-side in `conditions.ts:235,240`. The spec also missed `deckParts.tsx:131`'s nested count, `agentPick.ts`'s three quick-pick prompts, `config.ts:101`'s prompt template, `runs.ts:75`'s brief markdown, and `tasksView.ts:2113,2209`. All are covered above. Real totals are **84 source strings + 26 manifest across 24 files**, against the spec's grep-based estimate of ~71 + 35.

**Placeholder scan.** Every code step carries the actual code or an exact before→after row. The four manifest rows marked "rewrite per the vocabulary table" name the file, the field and the decision rule, and require the choice to be stated in the commit message — a judgement call with a stated procedure, not a TBD. Task 6 Step 5 requires reading a call site rather than guessing, with both outcomes specified.

**Type consistency.** `agentLabel: string` is the field name in `types.ts` (Task 2 Step 4), the value sent in `deckView.ts` (Step 5), the state in `DeckApp.tsx` (Step 6), and the prop on `ReviewStrip` (Task 4 Step 2) — one name throughout, matching the existing `agentLabel` already used in `tasksView.ts:243` and `App.tsx:143`. `Hit`, `hasAgentWord`, `userFacingStrings`, `scanSources`, `scanManifest`, `EXCLUDED_MODULES`, `LEGITIMATE` and `PENDING_LOCATIONS` are each defined once in Task 1 and used with those exact names in Tasks 2-10.
