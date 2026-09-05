// End-to-end proof for the ONE claim the notepad's image feature makes that no other
// test can make: that a note's attached image reaches the agent session the launch
// activates. Every other test in this suite mocks `fs`, so they can only show that
// `copyFileSync` was CALLED — not that a readable file ends up in the repo, that the
// brief names that exact path, and that the prompt the new window seeds into the
// session names it too. This file uses real `fs` against a real temp repo.
//
// Only two things are faked: `child_process` (openWorkspace shells out to `open -a`,
// which would launch an editor) and `vscode` (aliased suite-wide). `$HOME` is
// redirected before importing the module under test, because the plan file — the
// artifact that carries the seeded prompt to the new window — is written under
// `os.homedir()/.agentflow/plans` at module load time.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { setConfig } from "../../_mocks/vscode";

vi.mock("child_process", () => ({
  // `open -a` succeeds by invoking its callback with no error; execSync backs
  // `git ls-files` (no files) and the git-exclude write. It is `execFile`, not
  // `exec`: openInEditor spawns `open` with an argv array and no shell.
  execFile: vi.fn((_f: string, _a: string[], cb: (e: unknown) => void) => cb(null)),
  execSync: vi.fn(() => ""),
  execFileSync: vi.fn(() => ""),
}));

let home: string;
let repo: string;
let store: string;
let openWorkspace: typeof import("../../../src/engine/workspace").openWorkspace;
let attachmentRelPath: typeof import("../../../src/engine/workspace").attachmentRelPath;
let BRIEF_DIR: string;
let BRIEF_FILE: string;
const realHome = process.env.HOME;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "np-seed-home-"));
  process.env.HOME = home;
  // Imported AFTER $HOME is set: PLAN_DIR is computed once, at module load.
  vi.resetModules();
  const mod = await import("../../../src/engine/workspace");
  openWorkspace = mod.openWorkspace;
  attachmentRelPath = mod.attachmentRelPath;
  BRIEF_DIR = mod.BRIEF_DIR;
  BRIEF_FILE = mod.BRIEF_FILE;

  repo = fs.mkdtempSync(path.join(os.tmpdir(), "np-seed-repo-"));
  fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
  store = fs.mkdtempSync(path.join(os.tmpdir(), "np-seed-store-"));
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  for (const d of [home, repo, store]) fs.rmSync(d, { recursive: true, force: true });
});

/** Every staged image's bytes under `dir`, sorted — read recursively, so a test asserts
 *  what survived a launch without asserting the layout it survived in. */
function imageBytes(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .map((f) => path.join(dir, f))
    .filter((p) => fs.statSync(p).isFile())
    .map((p) => fs.readFileSync(p, "utf8"))
    .sort();
}

describe("a notepad note's images reach the seeded session", () => {
  it("lands a readable file in the repo, names it in the brief, and names it in the prompt the session gets", async () => {
    // The bytes a user pasted, as they sit in the image store.
    const source = path.join(store, "img1.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    fs.writeFileSync(source, bytes);

    // Composed exactly as runNotepadItem composes them (tasksView.ts) — through the same
    // `attachmentRelPath` the copy uses, and repo-relative because the agent's cwd is the
    // repo root.
    const key = "notepad-rail-colour-n1";
    const attachments = [{ path: source, name: "before.png" }];
    const rel = `${BRIEF_DIR}/images/${attachmentRelPath(key, attachments, 0)}`;
    setConfig({ agentSurface: undefined });
    await openWorkspace({
      ticket: { key, summary: "Rail colour", url: "" },
      planMd:
        "## Notepad: Rail colour\n\n_No ticket._\n\nthe rail goes red on stale\n\n" +
        `## Attached images\n\n- \`${rel}\``,
      descriptionText: "the rail goes red on stale",
      attachments,
      services: [{ name: path.basename(repo), path: repo, isGit: true }],
      mode: "per-window",
      promptTemplate: "Start {key}: {summary}. Brief: {brief}",
      promptSuffix: `The user attached an image to this note. Read it before starting:\n- \`${rel}\``,
      workspaceDir: path.join(home, "ws"),
      seedAgent: true,
      kind: "notepad",
    });

    // 1 — a real, byte-identical file the agent can open at the path it is told.
    const landed = path.join(repo, ...rel.split("/"));
    expect(fs.existsSync(landed)).toBe(true);
    expect(fs.readFileSync(landed)).toEqual(bytes);

    // 2 — the brief names that same path, and the path resolves from the repo root
    // (which is the agent's cwd), not from the brief's own directory.
    const brief = fs.readFileSync(path.join(repo, BRIEF_DIR, BRIEF_FILE), "utf8");
    expect(brief).toContain("## Attached images");
    expect(brief).toContain(rel);
    expect(fs.existsSync(path.join(repo, rel))).toBe(true);

    // 3 — the prompt the newly opened window will seed into the agent session. This
    // is the actual delivery mechanism: maybeSeedAgent reads this file in the new
    // window and types `prompt` into the agent. If the image were named only in the
    // brief, a session that never opened TASK.md would never learn of it.
    const plans = path.join(home, ".agentflow", "plans");
    const file = fs.readdirSync(plans).find((f) => f.startsWith("notepad-rail-colour-n1-"));
    expect(file).toBeTruthy();
    const plan = JSON.parse(fs.readFileSync(path.join(plans, file!), "utf8"));
    expect(plan.seedAgent).toBe(true);
    expect(plan.matches).toHaveLength(1);
    const prompt: string = plan.matches[0].prompt;
    expect(prompt).toContain("Read it before starting");
    expect(prompt).toContain(rel);

    // 4 — and the git-exclude covers the copies, so a note's screenshot can never be
    // committed by an agent running `git add -A` in that repo.
    expect(fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8")).toContain(`${BRIEF_DIR}/`);
  });

  it("gives two same-named images two distinct files, both named in the brief", async () => {
    const a = path.join(store, "i-a.png");
    const b = path.join(store, "i-b.png");
    fs.writeFileSync(a, "AAA");
    fs.writeFileSync(b, "BBB");
    const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), "np-seed-repo2-"));
    fs.mkdirSync(path.join(repo2, ".git", "info"), { recursive: true });
    try {
      await openWorkspace({
        ticket: { key: "notepad-two-shots-n2", summary: "Two shots", url: "" },
        planMd: "## Notepad: Two shots",
        descriptionText: "",
        attachments: [
          { path: a, name: "shot.png" },
          { path: b, name: "shot.png" },
        ],
        services: [{ name: path.basename(repo2), path: repo2, isGit: true }],
        mode: "per-window",
        promptTemplate: "Start {key}",
        workspaceDir: path.join(home, "ws"),
        seedAgent: false,
        kind: "notepad",
      });
      const contents = imageBytes(path.join(repo2, BRIEF_DIR, "images"));
      expect(contents).toHaveLength(2);
      // Neither copy overwrote the other — distinct names, distinct bytes.
      expect(contents).toEqual(["AAA", "BBB"]);
    } finally {
      fs.rmSync(repo2, { recursive: true, force: true });
    }
  });

  // The collision the test above cannot see: it stages two images in ONE launch, where
  // `attachmentFileName` already de-duplicates. Two SEPARATE launches into the same
  // checkout each de-duplicate against their own list only, so before images were
  // namespaced by run key both notes landed on `images/image.png` — and every pasted
  // screenshot is named exactly that (`saveImage` defaults the display name to
  // `image.<ext>`). The second take then overwrote the first note's screenshot under a
  // running agent, which reads the file when it gets to it, not when it is launched.
  //
  // Asserted on the bytes that survive rather than on the paths they sit at, so it pins
  // the guarantee — each note keeps its own screenshot — rather than the layout that
  // currently delivers it. That the BRIEF names the same layout is pinned separately, by
  // the runNotepadItem tests in tasksView.test.ts, since the brief's image lines are
  // composed there.
  it("keeps each note's image when a second note is taken into the same checkout", async () => {
    const a = path.join(store, "first.png");
    const b = path.join(store, "second.png");
    fs.writeFileSync(a, "FIRST");
    fs.writeFileSync(b, "SECOND");
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), "np-seed-shared-"));
    fs.mkdirSync(path.join(shared, ".git", "info"), { recursive: true });
    const take = (key: string, source: string) =>
      openWorkspace({
        ticket: { key, summary: key, url: "" },
        planMd: `## Notepad: ${key}`,
        descriptionText: "",
        // Both notes' images carry the same display name, as every pasted screenshot does.
        attachments: [{ path: source, name: "image.png" }],
        services: [{ name: path.basename(shared), path: shared, isGit: true }],
        mode: "per-window",
        promptTemplate: "Start {key}",
        workspaceDir: path.join(home, "ws"),
        seedAgent: false,
        kind: "notepad",
      });

    try {
      await take("notepad-rail-colour-n5", a);
      await take("notepad-tooltip-repos-n6", b);

      // The second take did not overwrite the first note's screenshot: both notes'
      // bytes are still there for whichever agent reads its own path.
      expect(imageBytes(path.join(shared, BRIEF_DIR, "images"))).toEqual(["FIRST", "SECOND"]);
    } finally {
      fs.rmSync(shared, { recursive: true, force: true });
    }
  });
});
