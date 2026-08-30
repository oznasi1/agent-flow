/** The `agentFlow.neverAutoRun` denylist: command text a flow may never execute
 * unattended, no matter what the user has already consented to.
 *
 * This is deliberately NOT another consent gate. `Flow.launchConfirmedAt` and
 * `Flow.commandConfirmedAt` answer "has the user agreed to this KIND of spend",
 * and they are per-flow and permanent — approve one `deploy.sh` and every command
 * node in that flow runs unattended from then on, including ones added later.
 * That granularity is the thing this list exists to survive: it outranks every
 * stored approval, so a matching command is refused whether or not the flow was
 * confirmed, and there is no button anywhere that makes it run. The only way past
 * it is editing the setting, which is a deliberate act in a different surface than
 * the modal a user clicks through at 2am.
 *
 * It matters most because of `{note}`: `command.ts`'s `withNote` splices a rule's
 * free text into the command UNQUOTED and by design, so `deploy.sh --env={note}`
 * with a note of `prod; rm -rf ~` is a real, documented shape. The match therefore
 * runs against the RESOLVED text, after that splice — matching the template would
 * inspect exactly the string that isn't dangerous.
 *
 * Pure and dependency-free on purpose (no `fs`/`path`, no npm glob library): the
 * orchestrator's modules are reachable from the Deck webview bundle, where a Node
 * import breaks `npm run build`. */

/** Compile one user-written pattern to a whole-string matcher.
 *
 * The syntax is `*` (any run of characters, including none) and `?` (exactly one
 * character). EVERYTHING else is a literal — every regex metacharacter is escaped,
 * so `deploy.sh` means a dot and `a|b` means a pipe. A user writing a line in
 * settings.json is not opting into authoring a regex, and silently treating one as
 * a regex would make `.` match any character in the single most common pattern
 * anyone will write.
 *
 * `[\s\S]` rather than `.`: a JS `.` does not cross a newline, and the operative
 * fragment of a command is very often on a later line of a heredoc or a wrapped
 * pipeline. A `*rm -rf*` that quietly stopped at the first newline would be a
 * denylist that reads as covering more than it does — the worst failure this
 * setting can have.
 *
 * Case-insensitive, which is the one place this deliberately over-matches. A
 * denylist's errors should fall on the side of refusing too much: a wrongly
 * blocked command costs one edit to the setting, a wrongly allowed one runs. */
function toMatcher(pattern: string): RegExp {
  let src = "";
  for (const ch of pattern) {
    if (ch === "*") src += "[\\s\\S]*";
    else if (ch === "?") src += "[\\s\\S]";
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${src}$`, "i");
}

/** The first `agentFlow.neverAutoRun` pattern that `text` matches, or `undefined`
 * when none do. Returns the PATTERN, not a boolean, because the refusal names it:
 * a user whose deploy stopped needs to know which line of their settings to look
 * at, and "blocked by a rule you configured somewhere" is not a diagnosis.
 *
 * Blank and non-string entries are ignored rather than matched. A hand-edited
 * settings file can carry `""`, `"   "` or `42`, and an empty pattern compiled
 * literally would be a whole-string match against `""` — harmless — but treating
 * blanks as rules at all invites the reading that one might be a catch-all. Being
 * explicit here is cheaper than the doubt. Non-strings are guarded for the same
 * reason `command.ts` guards `node.run`: `settings.json` is a text file a user
 * edits by hand, and nothing validates its contents before they reach this. */
export function blockedBy(text: string, patterns: string[]): string | undefined {
  return patterns.find(
    (p) => typeof p === "string" && p.trim() !== "" && toMatcher(p).test(text),
  );
}
