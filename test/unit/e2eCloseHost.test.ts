// The hang classifier behind `closeHost` (test-e2e/_helpers/host.ts). It decides
// whether a stalled Electron quit is Electron's own (every extension host already
// exited — kill and carry on) or possibly ours (a host still alive — fail with
// the evidence), so its reading of VS Code's log shapes is pinned here against
// lines copied from a real CI hang.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { extensionHostsExited, hostLogTails, killTree } from "../../test-e2e/_helpers/host";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** A sandbox `user-data` dir with the logs a two-window session leaves. */
function sandboxLogs(over: { mainExtra?: string; window2Extra?: string } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "af-closehost-"));
  dirs.push(root);
  const logs = path.join(root, "logs", "20260906T113403");
  fs.mkdirSync(path.join(logs, "window1", "exthost"), { recursive: true });
  fs.mkdirSync(path.join(logs, "window2", "exthost"), { recursive: true });
  fs.writeFileSync(path.join(logs, "main.log"), [
    "2026-09-06 11:34:03.301 [info] update#ctor - updates are disabled by the environment",
    "2026-09-06 11:34:07.880 [info] Extension host with pid 12059 exited with code: 0, signal: unknown.",
    "2026-09-06 11:34:07.921 [error] [UtilityProcess id: 1, type: fileWatcher, pid: 12037]: crashed with code 15 and reason 'killed'",
    "2026-09-06 11:34:08.105 [info] Extension host with pid 12163 exited with code: 0, signal: unknown.",
    over.mainExtra ?? "",
  ].join("\n"));
  fs.writeFileSync(path.join(logs, "window1", "exthost", "exthost.log"), "2026-09-06 11:34:05.581 [info] Extension host with pid 12059 started\n");
  fs.writeFileSync(path.join(logs, "window2", "exthost", "exthost.log"), `2026-09-06 11:34:08.065 [info] Extension host with pid 12163 started\n${over.window2Extra ?? ""}`);
  return root;
}

describe("extensionHostsExited", () => {
  it("reads started pids off each window's exthost.log and exited pids off main.log — CI's own shape", () => {
    expect(extensionHostsExited(sandboxLogs())).toEqual({ started: [12059, 12163], alive: [] });
  });

  it("names a host that started and never exited", () => {
    const root = sandboxLogs({ window2Extra: "2026-09-06 11:34:09.000 [info] Extension host with pid 12999 started\n" });
    expect(extensionHostsExited(root)).toEqual({ started: [12059, 12163, 12999], alive: [12999] });
  });

  it("is undefined when the sandbox has no logs at all", () => {
    expect(extensionHostsExited(path.join(os.tmpdir(), "af-closehost-none"))).toBeUndefined();
  });
});

describe("hostLogTails", () => {
  it("tails every log it knows, naming each by its path under the sandbox", () => {
    const lines = hostLogTails(sandboxLogs(), 2);
    expect(lines.some((l) => l.includes("--- logs/20260906T113403/main.log (last 2 lines)"))).toBe(true);
    expect(lines.some((l) => l.includes("window2/exthost/exthost.log"))).toBe(true);
    expect(lines.some((l) => l.includes("pid 12163 exited"))).toBe(true);
    expect(lines.some((l) => l.includes("update#ctor"))).toBe(false); // outside the tail
  });

  it("says so, rather than throwing, when there is nothing to tail", () => {
    expect(hostLogTails("/nonexistent/user-data")[0]).toContain("no VS Code logs under");
  });
});

describe("killTree", () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it("kills a process and the child it spawned, and waits for both to be gone", async () => {
    // A shell that spawns a grandchild `sleep` and waits on it — killing only the
    // shell would leave the sleep running, reparented to init.
    const sh = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], { stdio: ["ignore", "pipe", "ignore"] });
    const childPid = await new Promise<number>((resolve) => sh.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
    expect(alive(sh.pid!)).toBe(true);
    expect(alive(childPid)).toBe(true);
    const started = Date.now();
    await killTree(sh.pid!);
    // Both gone, and promptly — the wait yields so Node can reap its own child
    // rather than spinning the whole deadline on a zombie.
    expect(alive(childPid)).toBe(false);
    expect(alive(sh.pid!)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("is quiet about a pid that is already gone", async () => {
    await expect(killTree(2 ** 22 - 7)).resolves.toBeUndefined();
  });
});
