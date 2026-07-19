export interface PromptVars {
  key: string;
  summary: string;
  url: string;
  brief: string;
}

/** Render a prompt-mode template. Placeholders: {key} {summary} {url} {brief} {files}.
 * {files} expands to a "Relevant files: @a @b" block, or nothing when there are none. */
export function renderPrompt(template: string, vars: PromptVars, mentions: string[]): string {
  const files = mentions.length ? `\n\nRelevant files: ${mentions.join(" ")}` : "";
  return template
    .replace(/\{key\}/g, vars.key)
    .replace(/\{summary\}/g, vars.summary)
    .replace(/\{url\}/g, vars.url)
    .replace(/\{brief\}/g, vars.brief)
    .replace(/\{files\}/g, files);
}
