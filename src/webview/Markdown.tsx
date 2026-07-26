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
