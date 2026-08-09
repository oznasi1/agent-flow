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

/** Appended to the PR-review prompt (just before {files}) when prReviewAutoFix is on. */
export const PR_REVIEW_AUTOFIX_CLAUSE =
  "If it's ready, go ahead and implement the requested changes on this branch so it's ready for me to review — " +
  "do not push or merge without me.";

/** Assemble the Address PR prompt: the configured base, with the auto-fix clause
 * inserted just before the trailing {files} block when prReviewAutoFix is on. Lives
 * here rather than in a view because two callers now need it — the sidebar's ticket
 * kick-off and the Deck's re-seed of an already-launched run — and because the clause
 * is the same kind of thing as SLACK_DM_SENTENCE above: a fragment the code appends,
 * not a setting default. */
export function prReviewTemplate(prompt: string, autoFix: boolean): string {
  return autoFix ? insertBeforeFiles(prompt, " " + PR_REVIEW_AUTOFIX_CLAUSE) : prompt;
}

/** Compose a rule's optional note into the agent's prompt template.
 * - If {note} is in the template, substitute the note there (slice-based, every occurrence).
 * - If no {note} but a note exists, append it before {files} (so files block stays last).
 * - If no note or only whitespace: return the template unchanged, byte for byte.
 * - Exception: if {note} is in the template but there is no note, remove the token
 *   (an agent must never receive the literal {note} placeholder). This is inconsistent
 *   with "return unchanged" but necessary to prevent shipping broken templates.
 *
 * Uses slice-based insertion throughout to avoid String.replace interpreting `$&`,
 * `$1`, `$'` in the note — user-authored free text makes this corruption reachable. */
export function composeAgentPrompt(template: string, note?: string): string {
  // No note or empty/whitespace-only note: return unchanged (except for the {note} removal exception)
  if (!note || note.trim() === "") {
    // EXCEPTION: If the template contains {note} but there's no note, remove the {note} tokens.
    // This is knowingly inconsistent with "return unchanged" but necessary because an agent
    // must never receive the literal {note} placeholder text.
    if (template.includes("{note}")) {
      let result = template;
      let index = 0;
      while ((index = result.indexOf("{note}", index)) !== -1) {
        result = result.slice(0, index) + result.slice(index + 6); // 6 = "{note}".length
      }
      return result;
    }
    return template;
  }

  // Template has {note}: substitute it there with the note (slice-based, every occurrence)
  if (template.includes("{note}")) {
    let result = template;
    let index = 0;
    while ((index = result.indexOf("{note}", index)) !== -1) {
      result = result.slice(0, index) + note + result.slice(index + 6); // 6 = "{note}".length
      index += note.length; // Move past the inserted note to avoid revisiting
    }
    return result;
  }

  // No {note} but note exists: use insertBeforeFiles to append (before {files})
  return insertBeforeFiles(template, "\n\n" + note);
}

/** Fill the Explore-only placeholders in a seeded template: `{services}` (the repos
 * picked for the session) and `{env}` (the environment, for actions that ask for
 * one). Substituted here rather than in renderPrompt so no other prompt path has to
 * supply an env it doesn't have — the same pre-substitution engine/review/launch.ts
 * does for {repo}/{number}/{author}. `{env}` is left as-is when no env was
 * collected, so a user who adds it to an action that never asks sees an unfilled
 * placeholder rather than a silent blank. Function-replacers keep `$&`/`$1` inside
 * a typed value verbatim. */
export function applyExploreVars(template: string, vars: { env?: string; services: string }): string {
  const { env, services } = vars;
  const filled = template.replace(/\{services\}/g, () => services);
  return env === undefined ? filled : filled.replace(/\{env\}/g, () => env);
}
