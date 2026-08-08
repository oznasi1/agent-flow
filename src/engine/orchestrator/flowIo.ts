// The fs boundary for flows, and the one place a flow id is minted. Every other
// module in this directory is pure and stays that way; this file exists so that
// `store.ts` can be tested from an in-memory fake and still have a real
// implementation in production.
import * as fs from "fs";
import * as path from "path";
import { FlowIo } from "./store";
import { LockIo } from "./lock";

/** Mint a flow id. The charset is not cosmetic: `store.ts` builds a filename from
 * an id and rejects anything outside `[A-Za-z0-9_-]`, so a slug-from-name scheme
 * would throw on the first flow called "My flow". Time-ordered base36 prefix plus a
 * random base36 salt (always 4 chars). Same-millisecond collisions are unlikely but
 * not impossible — the salt space is 36^4 ≈ 1.68M, so this is probabilistic, not a
 * guarantee. The caller (Task 3) is responsible for not overwriting an existing id.
 * `rand` is injectable to keep the test deterministic. */
export function newFlowId(nowMs: number, rand: () => number = Math.random): string {
  const stamp = Math.floor(nowMs).toString(36);
  const salt = (Math.floor(rand() * 36 ** 4) % (36 ** 4))
    .toString(36)
    .padStart(4, "0");
  return `f${stamp}-${salt}`;
}

/** The real IO. Every read degrades to `null` rather than throwing: a file can
 * vanish between `readDir` and `readFile` because `removeFlow` deletes, and an
 * unreadable entry must cost one flow rather than the whole drawer — the same
 * posture `engine/runs.ts` takes with a corrupt record. */
export function nodeFlowIo(): FlowIo {
  return {
    readDir: (dir) => fs.readdirSync(dir),
    readFile: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    writeFile: (p, text) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    },
    remove: (p) => fs.rmSync(p, { force: true }),
  };
}

/** The lock's real IO. `wx` is the whole point: an atomic exclusive create, so two
 * windows racing for the lock cannot both believe they took it.
 *
 * `log` is optional so tests can omit it; the panel passes its channel. It exists
 * because EEXIST and "the filesystem is broken" both have to return false — the
 * lock must fail closed, and a throw here would escape into the Deck's refresh —
 * but a permissions error silently presenting as "another window holds it" would
 * strand an armed flow forever with nothing to diagnose. */
export function nodeLockIo(log?: (m: string) => void): LockIo {
  return {
    tryCreate: (p, text) => {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text, { flag: "wx" });
        return true;
      } catch (e) {
        // EEXIST is the expected answer: somebody else won the race.
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
          log?.(`orchestrator: could not take the flows lock: ${(e as Error).message}`);
        }
        return false;
      }
    },
    read: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    remove: (p) => fs.rmSync(p, { force: true }),
  };
}
