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

/** Sentence appended to a seeded Explore prompt when the action's Slack-DM toggle
 * is on. The agent performs the DM via its own Slack connector. */
export const SLACK_DM_SENTENCE =
  "When you're done, send me a direct message on Slack summarizing the session (and link any Jira ticket you opened).";

/** Append the Slack-DM instruction to a prompt template. Placed just before the
 * first {files} placeholder so the relevant-files block stays at the very end;
 * appended to the end when the template has no {files}. A no-op when disabled. */
export function injectSlackDm(template: string, enabled: boolean): string {
  if (!enabled) return template;
  const sentence = " " + SLACK_DM_SENTENCE;
  return template.includes("{files}")
    ? template.replace("{files}", sentence + "{files}")
    : template + sentence;
}
