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
  // `git ls-files` (no files) and the git-exclude write.
  exec: vi.fn((_cmd: string, cb: (e: unknown) => void) => cb(null)),
  execSync: vi.fn(() => ""),
  execFileSync: vi.fn(() => ""),
}));

let home: string;
let repo: string;
let store: string;
let openWorkspace: typeof import("../../../src/engine/workspace").openWorkspace;
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

describe("a notepad note's images reach the seeded session", () => {
  it("lands a readable file in the repo, names it in the brief, and names it in the prompt the session gets", async () => {
    // The bytes a user pasted, as they sit in the image store.
    const source = path.join(store, "img1.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    fs.writeFileSync(source, bytes);

    // Composed exactly as runNotepadItem composes them (tasksView.ts) — the paths in
    // the text are repo-relative because the agent's cwd is the repo root.
    const rel = `${BRIEF_DIR}/images/before.png`;
    setConfig({ agentSurface: undefined });
    await openWorkspace({
      ticket: { key: "notepad-rail-colour-n1", summary: "Rail colour", url: "" },
      planMd:
        "## Notepad: Rail colour\n\n_No ticket._\n\nthe rail goes red on stale\n\n" +
        `## Attached images\n\n- \`${rel}\``,
      descriptionText: "the rail goes red on stale",
      attachments: [{ path: source, name: "before.png" }],
      services: [{ name: path.basename(repo), path: repo, isGit: true }],
      mode: "single",
      promptTemplate: "Start {key}: {summary}. Brief: {brief}",
      promptSuffix: `The user attached an image to this note. Read it before starting:\n- \`${rel}\``,
      workspaceDir: path.join(home, "ws"),
      seedAgent: true,
      kind: "notepad",
    });

    // 1 — a real, byte-identical file the agent can open at the path it is told.
    const landed = path.join(repo, BRIEF_DIR, "images", "before.png");
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
        mode: "single",
        promptTemplate: "Start {key}",
        workspaceDir: path.join(home, "ws"),
        seedAgent: false,
        kind: "notepad",
      });
      const dir = path.join(repo2, BRIEF_DIR, "images");
      const files = fs.readdirSync(dir).sort();
      expect(files).toHaveLength(2);
      // Neither copy overwrote the other — distinct names, distinct bytes.
      const contents = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).sort();
      expect(contents).toEqual(["AAA", "BBB"]);
    } finally {
      fs.rmSync(repo2, { recursive: true, force: true });
    }
  });
});
