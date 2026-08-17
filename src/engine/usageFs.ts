import * as fs from "fs";
import * as path from "path";
import { accumulateUsage, UsageLine, UsageTotals, zeroUsage } from "./usage";
import { encodeProjectDir } from "./transcript";

/** What is remembered about one transcript between sweeps. */
interface FileUsage {
  /** File size at the last read — the offset the next read starts from. */
  size: number;
  totals: UsageTotals;
  /** requestIds already counted. Bounded by request count, not bytes: about 51
   * ids for a 6MB transcript, so holding these for the host's lifetime is cheap. */
  seen: Set<string>;
  /** Bytes after the last newline of the previous read, held over so a line
   * split across two sweeps is parsed once and whole. A Buffer rather than a
   * string because a multi-byte character can straddle the boundary too, and
   * decoding half of one corrupts it. */
  pendingTail: Buffer;
}

const fresh = (): FileUsage => ({ size: 0, totals: zeroUsage(), seen: new Set(), pendingTail: Buffer.alloc(0) });

/**
 * Cumulative token usage from Claude Code transcripts, read incrementally.
 *
 * Transcripts are append-only, so each sweep parses only the bytes added since
 * the last one. That is what makes this affordable at all: the corpus on a
 * working machine runs to hundreds of megabytes across hundreds of files, with
 * single transcripts past 50MB.
 *
 * Never call this on the Deck's 6s refresh. It has its own slower cadence, and
 * `refresh()` reads the totals it computed out of memory. One instance is held
 * for the host's lifetime — the per-file caches are the whole point.
 *
 * Best-effort throughout: an unreadable file or directory contributes nothing
 * and never throws, exactly as `readAgentActivity` degrades.
 */
export class UsageReader {
  private cache = new Map<string, FileUsage>();

  /** Cumulative totals for one transcript, parsing only what is new. */
  readFile(file: string): UsageTotals {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return zeroUsage(); // missing or unreadable → contributes nothing
    }
    let e = this.cache.get(file);
    // A file smaller than we last saw was truncated or replaced under us: the
    // cached offset and dedup set describe content that no longer exists.
    if (!e || size < e.size) {
      e = fresh();
      this.cache.set(file, e);
    }
    if (size === e.size) return e.totals;

    let chunk: Buffer;
    let read: number;
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, "r");
      const len = size - e.size;
      const buf = Buffer.allocUnsafe(len);
      read = fs.readSync(fd, buf, 0, len, e.size);
      chunk = buf.subarray(0, read);
    } catch {
      return e.totals; // leave the offset untouched; retry on the next sweep
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* nothing useful to do about a failed close */
        }
      }
    }

    const text = Buffer.concat([e.pendingTail, chunk]);
    const nl = text.lastIndexOf(0x0a); // "\n"
    const complete = nl >= 0 ? text.subarray(0, nl).toString("utf8") : "";
    // Buffer.from copies, so the (possibly large) read buffer is not retained.
    e.pendingTail = Buffer.from(nl >= 0 ? text.subarray(nl + 1) : text);
    // Advance by bytes actually consumed, not the stat-derived target: a short
    // read (POSIX permits one on a regular file, and the file can also be
    // replaced between statSync and readSync) must not skip the unread
    // remainder. This is self-healing — size > e.size on the next sweep picks
    // up exactly what was missed.
    e.size += read;

    const lines: UsageLine[] = [];
    for (const r of complete.split("\n")) {
      // The fast path. Most lines in a transcript carry no usage, and this string
      // test is what keeps a 50MB file from costing 50MB of JSON.parse.
      if (!r.includes('"usage"')) continue;
      try {
        lines.push(JSON.parse(r) as UsageLine);
      } catch {
        /* tolerate a hand-edited or half-written line */
      }
    }
    accumulateUsage(lines, e.totals, e.seen);
    return e.totals;
  }

  /** Every transcript in one Claude Code project dir, summed. */
  readDir(dir: string): UsageTotals {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return zeroUsage();
    }
    const out = zeroUsage();
    for (const n of names) {
      const t = this.readFile(path.join(dir, n));
      out.input += t.input;
      out.output += t.output;
      out.cacheWrite += t.cacheWrite;
      out.cacheRead += t.cacheRead;
    }
    return out;
  }

  /**
   * One run's total: every transcript in every project dir its repos map to.
   *
   * There is deliberately NO branch join here, unlike `readAgentActivity`. The
   * sweep is affordable only because it rejects a line before parsing it, and a
   * branch join needs `gitBranch`, which lives on precisely the lines that test
   * skips. A task launched into a worktree has its own cwd, so its project dir
   * already holds exactly one branch's sessions and the figure is exact; only a
   * repo checked out directly pools several branches, and there the number is
   * the honest total for that directory. The card's tooltip says so.
   */
  readRun(projectsRoot: string, cwds: string[]): UsageTotals {
    const out = zeroUsage();
    // A multi-repo run can name one path twice (two repos under one root); the
    // per-file cache would still return that file's full total each time.
    for (const cwd of new Set(cwds)) {
      const t = this.readDir(path.join(projectsRoot, encodeProjectDir(cwd)));
      out.input += t.input;
      out.output += t.output;
      out.cacheWrite += t.cacheWrite;
      out.cacheRead += t.cacheRead;
    }
    return out;
  }
}
