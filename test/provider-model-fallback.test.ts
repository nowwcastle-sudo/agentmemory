import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createFallbackProvider } from "../src/providers/index.js";

// Everything this worker asks a model goes through one local gateway, so a
// fallback across provider TYPES (FALLBACK_PROVIDERS) does not help when the
// gateway itself answers "All models exhausted: 5 routes checked (4
// rate-limited or on cooldown)" -- which is exactly what it did on
// 2026-09-20, for minutes at a time, while the worker was pinned to one model
// (decision D-8, taken because the router's own pick spends the whole token
// budget on prose and returns no relations).
//
// OPENAI_FALLBACK_MODELS names models to try next on the same gateway, so the
// pin keeps its quality and stops being a single point of failure.

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:31415/v1";
  process.env.OPENAI_MODEL = "gpt-oss-120b";
  delete process.env.OPENAI_FALLBACK_MODELS;
  delete process.env.FALLBACK_PROVIDERS;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

const config = () => ({ provider: "openai" as const, model: "gpt-oss-120b", maxTokens: 4096 });

describe("model-level fallback on one gateway", () => {
  it("keeps a single provider when no fallback models are named", () => {
    const provider = createFallbackProvider(config(), { providers: [] });

    expect(provider.name).toContain("openai");
    expect(provider.name).not.toContain("fallback");
  });

  it("chains the named models after the primary", () => {
    process.env.OPENAI_FALLBACK_MODELS = "auto,gpt-oss-20b";

    const provider = createFallbackProvider(config(), { providers: [] });

    // The chain reports the models it will try, primary first.
    expect(provider.name).toContain("gpt-oss-120b");
    expect(provider.name).toContain("auto");
    expect(provider.name).toContain("gpt-oss-20b");
  });

  it("ignores blanks and a repeat of the primary model", () => {
    process.env.OPENAI_FALLBACK_MODELS = " , gpt-oss-120b , auto ,";

    const provider = createFallbackProvider(config(), { providers: [] });

    expect(provider.name.match(/gpt-oss-120b/g)).toHaveLength(1);
    expect(provider.name).toContain("auto");
  });

  it("still chains other provider types when both are configured", () => {
    process.env.OPENAI_FALLBACK_MODELS = "auto";
    process.env.ANTHROPIC_API_KEY = "test-anthropic";

    const provider = createFallbackProvider(config(), { providers: ["anthropic"] });

    expect(provider.name).toContain("auto");
    expect(provider.name).toContain("anthropic");
  });
});
