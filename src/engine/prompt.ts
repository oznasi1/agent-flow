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

/** Insert `sentence` just before the first {files} placeholder so the relevant-files
 * block stays at the very end; append it when the template has no {files}. `sentence`
 * is inserted verbatim (caller includes any leading space) — slice-based, so `$`
 * patterns in it are never interpreted the way String.replace would. */
export function insertBeforeFiles(template: string, sentence: string): string {
  const i = template.indexOf("{files}");
  return i === -1 ? template + sentence : template.slice(0, i) + sentence + template.slice(i);
}

/** Sentence appended to a seeded Explore prompt when the action's Slack-DM toggle
 * is on. The agent performs the DM via its own Slack connector. */
export const SLACK_DM_SENTENCE =
  "When you're done, send me a direct message on Slack summarizing the session (and link any Jira ticket you opened).";

/** Append the Slack-DM instruction to a prompt template (before {files}). No-op when disabled. */
export function injectSlackDm(template: string, enabled: boolean): string {
  return enabled ? insertBeforeFiles(template, " " + SLACK_DM_SENTENCE) : template;
}
