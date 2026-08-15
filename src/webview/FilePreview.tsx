import * as React from "react";
import { Markdown } from "./Markdown";
import { LoadingMark } from "./LoadingMark";

/** The selected row's own file, rendered under its detail block. `fence` names a
 * language for content that isn't markdown — a hook's hooks.json, say. */
export function FilePreview({
  file,
  cached,
  fence,
  onOpen,
}: {
  file: string;
  cached: { text: string; truncated: boolean } | undefined;
  fence: string;
  onOpen: () => void;
}): JSX.Element {
  if (!file) return <div className="mdnone">Nothing to preview for this one.</div>;
  if (!cached) return <div className="mdnone lrow"><LoadingMark size={12} />Loading…</div>;
  if (!cached.text.trim()) return <div className="mdnone">Nothing to preview for this one.</div>;
  const text = fence ? `\`\`\`${fence}\n${cached.text}\n\`\`\`` : cached.text;
  return (
    <div className="preview">
      <Markdown text={text} />
      {cached.truncated && (
        <div className="mdtrunc">
          Truncated at 262,144 characters.{" "}
          <button type="button" className="btn" onClick={onOpen}>
            Open file
          </button>{" "}
          for the rest.
        </div>
      )}
    </div>
  );
}
