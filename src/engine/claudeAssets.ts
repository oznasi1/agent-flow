// Reads Claude Code's on-disk state (~/.claude and the open workspace) and derives
// the browsable asset list. Pure over an injected AssetReader so every rule here is
// unit-testable from fixture trees — this module must never import "vscode" or "fs".

export interface DirEntry {
  name: string;
  isDir: boolean;
}

/** The only I/O surface. Implementations return empty/null rather than throwing,
 * so one unreadable file degrades a single entry instead of the whole scan. */
export interface AssetReader {
  readFile(path: string): string | null;
  readDir(path: string): DirEntry[];
  isDir(path: string): boolean;
}

/** Parse a leading `---` fenced block into flat key/value pairs. Continuation
 * lines (indented, no `key:`) fold into the preceding value — real skill
 * descriptions routinely wrap across several lines. */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text ?? "");
  if (!m) return {};
  const out: Record<string, string> = {};
  let key: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (key) out[key] = unquote(buf.join(" ").trim());
  };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (kv) {
      flush();
      key = kv[1];
      buf = [kv[2]];
    } else if (key && /^\s+\S/.test(line)) {
      buf.push(line.trim());
    }
  }
  flush();
  return out;
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "").trim();
}
