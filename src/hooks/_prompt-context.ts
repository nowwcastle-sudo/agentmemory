/**
 * Injecting memory at the moment the question exists.
 *
 * The session-start hook runs before the user has typed anything: the session
 * row has no first prompt, the session has no observations, and the focus
 * that ranks which past summaries to show is empty. Ranking then falls back
 * to recency, which on the 30 recall items of 2026-09-20 put the right
 * summary in front of the reader 6 times; with the question known it was 21.
 *
 * The first prompt is where that gap closes. Later prompts are left alone --
 * the session has its own observations by then, and the block is already in
 * the transcript.
 */

/** The shortest prompt worth ranking against. Two words of greeting are not. */
const MIN_PROMPT_CHARS = 12;

export function shouldInjectOnPrompt(
  session: { observationCount?: number } | null | undefined,
  prompt: unknown,
): boolean {
  if (!session) return false;
  if (typeof prompt !== "string" || prompt.trim().length < MIN_PROMPT_CHARS) return false;
  const count = session.observationCount;
  return typeof count === "number" && count <= 1;
}

export function promptContextPayload(context: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  });
}
