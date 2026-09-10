import { describe, it, expect } from "vitest";
import { stripPrivateData } from "../src/functions/privacy.js";

describe("stripPrivateData", () => {
  it("strips private tags", () => {
    expect(stripPrivateData("hello <private>secret</private> world")).toBe(
      "hello [REDACTED] world",
    );
  });

  it("strips private tags case-insensitive", () => {
    expect(stripPrivateData("<Private>data</Private>")).toBe("[REDACTED]");
  });

  it("strips API keys", () => {
    expect(stripPrivateData("api_key=sk-ant-1234567890abcdefghij")).toBe(
      "[REDACTED_SECRET]",
    );
  });

  it("strips GitHub PATs", () => {
    expect(
      stripPrivateData("token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh"),
    ).toBe("[REDACTED_SECRET]");
  });

  it("strips standalone GitHub PATs", () => {
    expect(
      stripPrivateData("found ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij here"),
    ).toBe("found [REDACTED_SECRET] here");
  });

  it("strips Slack tokens", () => {
    expect(stripPrivateData("xoxb-123456-789012-abcdef")).toBe(
      "[REDACTED_SECRET]",
    );
  });

  it("strips AWS access keys", () => {
    expect(stripPrivateData("key=AKIAIOSFODNN7EXAMPLE")).toBe(
      "key=[REDACTED_SECRET]",
    );
  });

  it("strips JWT tokens", () => {
    expect(
      stripPrivateData(
        "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpM",
      ),
    ).toBe("[REDACTED_SECRET]");
  });

  // Live graph 2026-09-11: a file node named "...\ta[REDACTED_SECRET].md" --
  // "task-1-report-20260907-1234567890.md" lost its tail because "sk-" inside
  // "task-" matched the key pattern with no word boundary in front of it.
  it("leaves words that merely contain a key prefix alone", () => {
    const path = "records/task-1-report-20260907-1234567890abcdef.md";
    expect(stripPrivateData(path)).toBe(path);
    expect(stripPrivateData("mask-2026-09-11-abcdefghijklmnopqrstuv")).toBe("mask-2026-09-11-abcdefghijklmnopqrstuv");
    expect(stripPrivateData("desk-ABCDEFGHIJKLMNOPQRSTUVWXYZ")).toBe("desk-ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(stripPrivateData("key sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ end")).toBe("key [REDACTED_SECRET] end");
    expect(stripPrivateData("(sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ)")).toBe("([REDACTED_SECRET])");
  });

  it("strips sk- prefixed keys", () => {
    expect(stripPrivateData("sk-1234567890abcdefghijklmnopqr")).toBe(
      "[REDACTED_SECRET]",
    );
  });

  it("strips OpenAI project keys", () => {
    expect(
      stripPrivateData("sk-proj-1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"),
    ).toBe("[REDACTED_SECRET]");
  });

  it("strips GitHub fine-grained service tokens", () => {
    expect(
      stripPrivateData("ghs_1234567890abcdefghijklmnopqrstuvwxyzAB"),
    ).toBe("[REDACTED_SECRET]");
  });

  it("strips bearer tokens", () => {
    expect(
      stripPrivateData(
        "Authorization: Bearer sk-proj-1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
      ),
    ).toBe("Authorization: [REDACTED_SECRET]");
  });

  it("handles multiple secrets in one string", () => {
    const input =
      "sk-abcdefghijklmnopqrstuv and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const result = stripPrivateData(input);
    expect(result).not.toContain("sk-");
    expect(result).not.toContain("ghp_");
  });

  it("does not strip short strings", () => {
    expect(stripPrivateData("api_key=short")).toBe("api_key=short");
  });

  it("returns empty string unchanged", () => {
    expect(stripPrivateData("")).toBe("");
  });

  it("handles no secrets gracefully", () => {
    expect(stripPrivateData("normal text without secrets")).toBe(
      "normal text without secrets",
    );
  });

  it("works correctly on consecutive calls (no regex statefulness)", () => {
    const input = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZabc";
    expect(stripPrivateData(input)).toBe("[REDACTED_SECRET]");
    expect(stripPrivateData(input)).toBe("[REDACTED_SECRET]");
    expect(stripPrivateData(input)).toBe("[REDACTED_SECRET]");
  });
});
