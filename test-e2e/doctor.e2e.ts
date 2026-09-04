import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { runCommand } from "./_helpers/palette";
import { installForgeShims, ghAuthStatusAnswer, forgeCalls, expectNoUnknownForgeCalls } from "./_helpers/forgeShim";
import { shot } from "./_helpers/shot";

let sb: Sandbox | undefined;
let app: ElectronApplication | undefined;

/** Journey: the Doctor command. Every row is a `vscode.window.showQuickPick`
 *  item built by `buildItems` (src/doctorView.ts:236-252) out of a `Check`
 *  (src/engine/doctor.ts), so the DOM facts are:
 *   - `label` = `${ICON[status]} ${check.label}`, where ICON is a CODICON
 *     (`$(pass)` / `$(error)` / `$(warning)` / `$(circle-slash)`) that the
 *     workbench renders as `<span class="codicon codicon-pass">` and NOT as
 *     text — so a row's verdict is asserted on that class, never on a word.
 *   - `description` = `check.detail`.
 *   - `detail` = the action's own label, prefixed `$(arrow-small-right)`.
 *
 *  `agentFlow.prFacts` defaults to TRUE (package.json), so Doctor shells
 *  `gh auth status` on every run here — every test installs the forge shims, or
 *  the verdict would depend on the developer's own `gh`.
 */

/** The QuickPick, on the top-level page: pickers are workbench chrome, outside
 *  every `iframe.webview`. Selectors read from VS Code 1.96.2's workbench DOM on
 *  2026-09-04, the same ones `_helpers/palette.ts` and `surface-edges.e2e.ts`
 *  already use. */
const widget = (page: Page) => page.locator(".quick-input-widget");
const rows = (page: Page) => widget(page).locator(".quick-input-list .monaco-list-row");

/** Type a query into the quick input, replacing whatever is there.
 *
 *  Filtering is not a convenience here, it is a requirement: the list is a
 *  virtualised `monaco-list`, so a row scrolled out of view is not in the DOM at
 *  all and no locator can reach it. The filter matches the LABEL only
 *  (`matchOnDescription`/`matchOnDetail` are both left at their false default),
 *  which is why every helper below takes a label and reads the detail back off
 *  the row afterwards. */
async function filterTo(page: Page, label: string): Promise<Locator> {
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(label);
  return rows(page).filter({ hasText: label });
}

/** The one row whose text carries `label`. */
async function row(page: Page, label: string): Promise<Locator> {
  const found = await filterTo(page, label);
  await expect(found).toHaveCount(1, { timeout: 15_000 });
  return found.first();
}

/** How many rows match, without requiring any — for the negative assertions (no
 *  `Project configured` row on a connector whose scope noun is `file`, no Cursor
 *  row on a VS Code host). */
async function rowCount(page: Page, label: string): Promise<number> {
  const found = await filterTo(page, label);
  // Let the list settle on the new query before counting: an immediate read can
  // catch the pre-filter rows and report a match that is about to disappear.
  await expect
    .poll(() => found.count(), { timeout: 10_000, intervals: [250, 250, 250, 250] })
    .toBeLessThanOrEqual(1);
  return found.count();
}

/** Codicon classes, one per `CheckStatus` (`ICON`, src/doctorView.ts:229-234). */
const VERDICT = { ok: "codicon-pass", fail: "codicon-error", warn: "codicon-warning", skip: "codicon-circle-slash" };

async function openDoctor(page: Page): Promise<void> {
  // The bare command title, not the category-qualified one (see `runCommand`).
  // `thenTitle` because Doctor's QuickPick replaces the palette in the SAME
  // widget, so "the palette went hidden" can never fire.
  await runCommand(page, "Doctor", { thenTitle: "Agent Flow Deck Doctor" });
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
}

/** The sandbox's user `settings.json`, where `ConfigurationTarget.Global` lands.
 *  The assertion of record for every "writes nothing" claim. */
const settingsFile = (s: Sandbox): string => path.join(s.userDataDir, "User", "settings.json");

/** Every file under the sandbox that Doctor could plausibly touch, as
 *  `relative/path\tbytes` lines. Four paths are excluded, each for a reason
 *  about the HOST or the harness rather than about Doctor:
 *   - `user-data/` and `extensions/`: VS Code's own state — logs, workspace
 *     storage, `globalState` — which the workbench rewrites continuously no
 *     matter what the extension does. `settings.json` inside it is compared
 *     separately and exactly, because that is the file a setting write lands in.
 *   - `home/.agentflow/windows/` and `home/.agentflow/attention.json`: the
 *     extension's 6s poll owns both (`agentFlow.trackOpenWindows` defaults to
 *     true, and `attentionPass` runs every other tick), so they move on a timer
 *     for the whole test. That is presence and attention, not Doctor.
 *   - `forge-answers/`: the shim's own `calls.jsonl`, which grows by exactly the
 *     probe the copy test asserts Doctor makes. */
function tree(s: Sandbox): string[] {
  const skip = new Set([
    path.join(s.root, "user-data"),
    path.join(s.root, "extensions"),
    path.join(s.root, "forge-answers"),
    path.join(s.home, ".agentflow", "windows"),
    path.join(s.home, ".agentflow", "attention.json"),
  ]);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (skip.has(full)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(`${path.relative(s.root, full)}\t${fs.statSync(full).size}`);
    }
  };
  walk(s.root);
  return out.sort();
}

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  const s = sb;
  sb = undefined;
  if (!s) return;
  try {
    expectNoUnknownForgeCalls(s);
  } finally {
    s.dispose();
  }
});

// Mutation-checked: `src/engine/doctor.ts`'s two `!i.authProbe` / `!i.projectProbe`
// arms rendering `status: "ok"` instead of `"skip"` — both rows then carry
// `codicon-pass` and this fails.
test("the fixture connector's probe rows read skip, never pass", async ({}, testInfo) => {
  test.setTimeout(180_000);
  sb = makeSandbox();
  installForgeShims(sb, { gh: { "auth status": ghAuthStatusAnswer(["oznasi1"]) } });
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openDoctor(page);
  await shot(page, testInfo, "1 · the Doctor report");

  // The fixture connector's `probe()` returns `{}` — both members deliberately
  // absent (src/tasks/fixture/connector.ts) — which CONNECTORS.md §4 says Doctor
  // must render as `skip`, "not as a silent pass".
  const valid = await row(page, "Credentials valid");
  await expect(valid.locator(`.${VERDICT.skip}`)).toHaveCount(1);
  await expect(valid.locator(`.${VERDICT.ok}`)).toHaveCount(0);
  await expect(valid).toContainText("not probed");
  await shot(page, testInfo, "2 · Credentials valid — skip, not pass");

  // The scope row is the same rule on the other probe. Its label is built from
  // the connector's own scope noun, so on the fixture it reads "File resolves".
  const resolves = await row(page, "File resolves");
  await expect(resolves.locator(`.${VERDICT.skip}`)).toHaveCount(1);
  await expect(resolves.locator(`.${VERDICT.ok}`)).toHaveCount(0);
  await expect(resolves).toContainText("not probed");

  // Positive control: a row that IS a pass on this very report renders the pass
  // codicon, so the two assertions above are not merely "no codicon anywhere".
  const stored = await row(page, "Credentials stored");
  await expect(stored.locator(`.${VERDICT.ok}`)).toHaveCount(1);
  await shot(page, testInfo, "3 · File resolves — skip, beside a real pass");
});

// Mutation-checked: `src/engine/doctor.ts`'s `sourceChecks` building both scope
// rows from a literal `"Project"` instead of `Noun(i.scopeNoun)` — the two
// `File …` rows vanish and this fails.
test("Doctor labels rows from the connector's SourceInfo", async ({}, testInfo) => {
  test.setTimeout(180_000);
  sb = makeSandbox();
  installForgeShims(sb, { gh: { "auth status": ghAuthStatusAnswer(["oznasi1"]) } });
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openDoctor(page);

  // `scopeNoun: "file"` → capitalised into the row labels; `scopeValue` = the
  // tasks.json path → the row's detail (src/tasks/fixture/connector.ts's `info`).
  const configured = await row(page, "File configured");
  await expect(configured).toContainText(path.join(sb.fixtureDir, "tasks.json"));
  await shot(page, testInfo, "1 · the scope row is labelled from scopeNoun, detailed from scopeValue");

  // `endpoint` is the fixture dir, which is not an https URL, so the site row
  // reports the value it was given rather than inventing one.
  await expect(await row(page, "Site configured")).toContainText(sb.fixtureDir);

  // And Jira's own vocabulary is nowhere on this report: the labels really came
  // from the connector, not from a hardcoded noun.
  expect(await rowCount(page, "Project configured")).toBe(0);
  expect(await rowCount(page, "Project resolves")).toBe(0);
  await shot(page, testInfo, "2 · no Jira vocabulary on a non-Jira source");
});

// Mutation-checked: `src/engine/doctor.ts`'s `agentChecks` `ask` arm returning
// `claudeChecks(i)` alone — the Copilot and Codex rows vanish and this fails.
test("under agentProvider ask Doctor reports every tool", async ({}, testInfo) => {
  test.setTimeout(180_000);
  sb = makeSandbox({ "agentFlow.agentProvider": "ask" });
  installForgeShims(sb, { gh: { "auth status": ghAuthStatusAnswer(["oznasi1"]) } });
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openDoctor(page);
  await shot(page, testInfo, "1 · every host tool gets its rows under ask");

  // `hostProviders()` (src/config.ts:181-190) on a VS Code host is
  // claude-code + copilot + codex, and `ask` means the choice is not made until
  // launch — so Doctor answers for all three rather than guessing at one.
  await expect((await row(page, "Claude Code installed")).locator(`.${VERDICT.fail}`)).toHaveCount(1);
  expect(await rowCount(page, "Claude session files")).toBe(1);
  expect(await rowCount(page, "Copilot Chat available")).toBe(1);
  // The sandbox puts a `codex` shim first on PATH, so this row is a pass — which
  // proves the row is really probing rather than reporting a constant.
  const codex = await row(page, "Codex CLI on PATH");
  await expect(codex.locator(`.${VERDICT.ok}`)).toHaveCount(1);
  await expect(codex).toContainText(path.join(sb.root, "bin", "codex"));

  // Host-gated, not provider-gated: Cursor's row belongs to the Cursor host and
  // must not appear here even under `ask`. (The three rows above, on the same
  // report, are this absence's positive control.)
  expect(await rowCount(page, "Cursor chat available")).toBe(0);
  await shot(page, testInfo, "2 · Claude Code, Copilot and Codex — and no Cursor row on a VS Code host");
});

// Mutation-checked: `src/doctorView.ts`'s `applyAction` "setting" case calling
// `workbench.action.openSettings` with no argument — the Settings editor then
// opens unfiltered and this fails.
test("picking a setting row opens Settings on that id", async ({}, testInfo) => {
  test.setTimeout(180_000);
  sb = makeSandbox();
  installForgeShims(sb, { gh: { "auth status": ghAuthStatusAnswer(["oznasi1"]) } });
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openDoctor(page);

  // `agentFlow.workspaceDir` points at a directory `makeSandbox` never creates,
  // so this row fails and carries the `{ kind: "setting" }` action
  // (`localChecks`, src/engine/doctor.ts). Its `detail` line is the action's own
  // label — the only hint the QuickPick gives that a row is actionable.
  const workspace = await row(page, "Workspace dir");
  await expect(workspace.locator(`.${VERDICT.fail}`)).toHaveCount(1);
  await expect(workspace).toContainText("Open setting");
  await shot(page, testInfo, "1 · a failing row offering Open setting");

  await workspace.click();
  await expect(widget(page)).toBeHidden({ timeout: 15_000 });

  // The assertion of record: the Settings editor is open and filtered on the
  // exact setting id the check named — not merely open.
  const settingsEditor = page.locator(".settings-editor");
  await expect(settingsEditor).toBeVisible({ timeout: 30_000 });
  // The Settings search box is a MONACO EDITOR, not an `<input>` (its container
  // is `.suggest-input-container`, `data-uri="settingseditor:searchinput0"` —
  // read off the live DOM on 2026-09-04), so its value is the rendered
  // `.view-lines` text and `toHaveValue` can never see it.
  await expect(settingsEditor.locator(".settings-header .search-container .view-lines"))
    .toHaveText("agentFlow.workspaceDir", { timeout: 15_000 });
  await shot(page, testInfo, "2 · Settings, filtered on agentFlow.workspaceDir");
});

// Mutation-checked: `src/doctorView.ts`'s `picked.copy` branch writing the bare
// string `"Agent Flow Deck Doctor"` instead of
// `formatReport(checks, inputs.sourceLabel)` — the clipboard then holds no rows
// and this fails.
test("Copy report fills the clipboard and writes nothing else", async ({}, testInfo) => {
  test.setTimeout(180_000);
  // `pbpaste` is the only way to read what the host put on the SYSTEM clipboard
  // from outside the Electron app, and it is macOS-only.
  test.skip(process.platform !== "darwin", "the clipboard read (pbpaste) is macOS-only");
  sb = makeSandbox();
  const sandbox = sb;
  installForgeShims(sandbox, { gh: { "auth status": ghAuthStatusAnswer(["oznasi1"]) } });
  const launched = await launchHost(sandbox);
  app = launched.app;
  const page = launched.page;

  // Clear the clipboard first, so anything read back afterwards is provably
  // Doctor's and not a leftover from the developer's own session.
  execFileSync("pbcopy", { input: "" });

  await openDoctor(page);
  const filesBefore = tree(sandbox);
  const settingsBefore = fs.readFileSync(settingsFile(sandbox), "utf8");

  await (await row(page, "Copy diagnostic report")).click();
  await expect(widget(page)).toBeHidden({ timeout: 15_000 });

  // The clipboard IS written — the positive half, and the control that makes the
  // "nothing else" half below mean something.
  await expect
    .poll(() => execFileSync("pbpaste", { encoding: "utf8" }), { timeout: 15_000 })
    .toContain("Agent Flow Deck Doctor");
  const report = execFileSync("pbpaste", { encoding: "utf8" });
  // Plain text, no codicons and no markup, and the `"source"` group placeholder
  // rendered as the connector's own label (`formatReport`, src/engine/doctor.ts).
  expect(report).toContain("[skip] Credentials valid");
  expect(report).toContain("Fixture:");
  expect(report).not.toContain("$(");

  // …and nothing else is written. PRIVACY.md: Doctor "writes nothing anywhere
  // except your clipboard, and only when you ask it to copy."
  expect(fs.readFileSync(settingsFile(sandbox), "utf8")).toBe(settingsBefore);
  expect(tree(sandbox)).toEqual(filesBefore);
  await shot(page, testInfo, "1 · the report copied, and nothing written");

  // And Doctor really did PROBE the forge CLI rather than only read config —
  // the other half of that PRIVACY paragraph. (Its two authenticated GETs are a
  // Jira-connector fact; the fixture connector's `probe()` makes no request, so
  // that half stays with `test/unit/engine/doctor.test.ts`.)
  expect(forgeCalls(sandbox).map((c) => `${c.cli} ${c.argv.join(" ")}`)).toContain("gh auth status");
});

// Mutation-checked: `src/engine/doctor.ts`'s `prReadChecks` returning `[]`
// unconditionally — the `PR reads` row disappears while the `gh` row stays green
// and this fails.
test("PR reads is its own row beside the CLI row", async ({}, testInfo) => {
  test.setTimeout(180_000);
  sb = makeSandbox({ "agentFlow.prFacts": true });
  // A CLI that is installed and signed in — `probe()` asks the GLOBAL question
  // and passes…
  installForgeShims(sb, { gh: { "auth status": ghAuthStatusAnswer(["oznasi1"]) } });
  // …while the per-repository reads it makes have failed. That trace is the
  // Deck's own fact cache, `~/.agentflow/prfacts/<key>.json`, written by
  // `writePrEntry` and read back by `summarisePrReads` (src/engine/pr/store.ts)
  // — the row's only input, and one Doctor reads whether or not the Deck was
  // ever opened. Seeded straight into the store, the way
  // `orchestrator-nodes.e2e.ts` seeds `~/.agentflow/flows`.
  const prfacts = path.join(sb.home, ".agentflow", "prfacts");
  fs.mkdirSync(prfacts, { recursive: true });
  fs.writeFileSync(
    path.join(prfacts, "E2E-1.json"),
    JSON.stringify({ "oznasi1/rocket": { facts: null, fetchedAt: Date.now(), error: true } }, null, 2) + "\n",
  );

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openDoctor(page);
  await shot(page, testInfo, "1 · a green CLI row and a failing-reads row, together");

  // Two rows, deliberately able to disagree (FORGES.md § 4: "Doctor's `PR reads`
  // row sits beside a CLI row that is honestly green"). The CLI row is a pass
  // and says where the binary was found…
  const cli = await row(page, "gh");
  await expect(cli.locator(`.${VERDICT.ok}`)).toHaveCount(1);
  await expect(cli).toContainText("signed in");
  await expect(cli).toContainText(path.join(sb.root, "bin", "gh"));

  // …and the reads row beside it names the run count and the repository.
  const reads = await row(page, "PR reads");
  await expect(reads).toContainText("last read failed for 1 run");
  await expect(reads).toContainText("oznasi1/rocket");
  // `warn`, not `fail`: a one-off blip and a permanently invisible repository
  // leave the same trace, so the row stops the report reading as an unqualified
  // all-clear without overstating the cause (`prReadChecks`, engine/doctor.ts).
  await expect(reads.locator(`.${VERDICT.warn}`)).toHaveCount(1);
  await shot(page, testInfo, "2 · PR reads — its own row, its own verdict");
});
