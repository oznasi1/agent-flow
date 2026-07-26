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
    // URLs legitimately contain balanced parens — a Wikipedia-style
    // "Foo_(disambiguation)" link is the usual case. A naive `[^)]*` stops at
    // that first `)` and leaks the rest of the URL (and the markdown link's own
    // closing paren) into the following text run, regardless of scheme.
    // Tolerate one level of nesting so the href is captured whole either way.
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
