import { describe, it, expect } from "vitest";
import { shouldInjectOnPrompt, promptContextPayload } from "../src/hooks/_prompt-context.js";

// The session-start hook injects context BEFORE the user has typed anything,
// so the session row has no first prompt and the focus that ranks past
// summaries is empty -- selection falls back to recency, which is what the
// 2026-09-20 measurements moved away from (rendered 6 of 30 by recency, 21
// when the question is known).
//
// The first prompt of a session is the moment the question exists and the
// memory has not yet been asked with it. Later prompts are left alone: by
// then the session has its own observations, the injected block is already
// in the transcript, and injecting on every turn would repeat it.

describe("shouldInjectOnPrompt", () => {
  it("injects on the first prompt of a session", () => {
    expect(shouldInjectOnPrompt({ observationCount: 0 }, "why did we pick that timeout")).toBe(true);
  });

  it("stays quiet on later prompts", () => {
    expect(shouldInjectOnPrompt({ observationCount: 12 }, "and what about retries")).toBe(false);
  });

  it("stays quiet when the session row is unknown", () => {
    expect(shouldInjectOnPrompt(null, "why did we pick that timeout")).toBe(false);
  });

  it("stays quiet for a prompt too short to rank anything", () => {
    expect(shouldInjectOnPrompt({ observationCount: 0 }, "hi")).toBe(false);
  });
});

describe("promptContextPayload", () => {
  it("uses the UserPromptSubmit shape", () => {
    const payload = JSON.parse(promptContextPayload("<agentmemory-context/>"));

    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(payload.hookSpecificOutput.additionalContext).toBe("<agentmemory-context/>");
  });
});
