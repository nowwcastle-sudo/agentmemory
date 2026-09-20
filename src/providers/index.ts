import type {
  MemoryProvider,
  ProviderConfig,
  FallbackConfig,
} from "../types.js";
import { AgentSDKProvider } from "./agent-sdk.js";
import { AnthropicProvider } from "./anthropic.js";
import { MinimaxProvider } from "./minimax.js";
import { NoopProvider } from "./noop.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";
import { ResilientProvider } from "./resilient.js";
import { FallbackChainProvider } from "./fallback-chain.js";
import { getEnvVar } from "../config.js";

export { createEmbeddingProvider, createImageEmbeddingProvider } from "./embedding/index.js";

function requireEnvVar(key: string): string {
  const value = getEnvVar(key);
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${key}. Set it in ~/.agentmemory/.env or as an environment variable.`,
    );
  }
  return value;
}

// #778: fallback providers used to inherit the primary provider's
// model name (e.g. fallback Gemini was called with `gpt-4o-mini`),
// 404'd every call, and tripped the circuit breaker — making
// FALLBACK_PROVIDERS actively worse than no fallback. Each provider
// must resolve its OWN env-driven default model. Mirrors the resolution
// in detectProvider() so primary + fallback agree on what each
// provider's default model is.
function defaultModelFor(providerType: ProviderConfig["provider"]): string {
  switch (providerType) {
    case "openai":
      return getEnvVar("OPENAI_MODEL") || "gpt-5.6-luna";
    case "anthropic":
      return getEnvVar("ANTHROPIC_MODEL") || "claude-sonnet-5";
    case "gemini":
      return getEnvVar("GEMINI_MODEL") || "gemini-3.7-flash";
    case "openrouter":
      return getEnvVar("OPENROUTER_MODEL") || "anthropic/claude-sonnet-5";
    case "minimax":
      return getEnvVar("MINIMAX_MODEL") || "MiniMax-M3";
    case "agent-sdk":
      return "claude-sonnet-5";
    case "noop":
    default:
      return "noop";
  }
}

export function createProvider(config: ProviderConfig): ResilientProvider {
  return new ResilientProvider(createBaseProvider(config));
}

/**
 * Models to try, on the same OpenAI-compatible endpoint, when the configured
 * one will not answer.
 *
 * FALLBACK_PROVIDERS switches provider TYPE, which buys nothing here: every
 * call goes through one local gateway, and on 2026-09-20 that gateway spent
 * minutes answering "All models exhausted: 5 routes checked (4 rate-limited
 * or on cooldown)" while the worker was pinned to a single model (D-8, taken
 * because the router's own pick spends the whole token budget on prose and
 * returns no relations). Naming other models keeps the pin's quality without
 * making it a single point of failure.
 *
 * The primary is never repeated, and blanks are dropped.
 */
function openAiFallbackModels(primaryModel: string): string[] {
  const raw = getEnvVar("OPENAI_FALLBACK_MODELS") || "";
  const seen = new Set([primaryModel]);
  const models: string[] = [];
  for (const entry of raw.split(",")) {
    const model = entry.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

/** The same provider, named by the model it will ask, so a chain reads. */
function namedForModel(provider: MemoryProvider, model: string): MemoryProvider {
  provider.name = `${provider.name}:${model}`;
  return provider;
}

export function createFallbackProvider(
  config: ProviderConfig,
  fallbackConfig: FallbackConfig,
): ResilientProvider {
  const modelChain =
    config.provider === "openai" ? openAiFallbackModels(config.model) : [];
  if (fallbackConfig.providers.length === 0 && modelChain.length === 0) {
    return createProvider(config);
  }

  const providers: MemoryProvider[] = [
    modelChain.length > 0
      ? namedForModel(createBaseProvider(config), config.model)
      : createBaseProvider(config),
  ];
  for (const model of modelChain) {
    try {
      providers.push(
        namedForModel(
          createBaseProvider({ ...config, model }),
          model,
        ),
      );
    } catch {
      // skip a model this build cannot construct a provider for
    }
  }
  for (const providerType of fallbackConfig.providers) {
    if (providerType === config.provider) continue;
    try {
      // #778: resolve the fallback's OWN default model (or its env
      // override) rather than copying config.model from the primary.
      // Without this, FALLBACK_PROVIDERS=gemini on an OpenAI primary
      // would call Gemini with `gpt-4o-mini`, get a 404 every time,
      // and trip the circuit breaker.
      const fbConfig: ProviderConfig = {
        provider: providerType,
        model: defaultModelFor(providerType),
        maxTokens: config.maxTokens,
      };
      providers.push(createBaseProvider(fbConfig));
    } catch {
      // skip unavailable fallback providers
    }
  }

  if (providers.length > 1) {
    return new ResilientProvider(new FallbackChainProvider(providers));
  }
  return new ResilientProvider(providers[0]);
}

function createBaseProvider(config: ProviderConfig): MemoryProvider {
  switch (config.provider) {
    case "minimax":
      return new MinimaxProvider(
        requireEnvVar("MINIMAX_API_KEY"),
        config.model,
        config.maxTokens,
      );
    case "anthropic":
      return new AnthropicProvider(
        requireEnvVar("ANTHROPIC_API_KEY"),
        config.model,
        config.maxTokens,
        config.baseURL,
      );
    case "gemini": {
      const geminiKey =
        getEnvVar("GEMINI_API_KEY") || getEnvVar("GOOGLE_API_KEY");
      if (!geminiKey) {
        throw new Error(
          "GEMINI_API_KEY (or GOOGLE_API_KEY) is required for the gemini provider",
        );
      }
      return new OpenRouterProvider(
        geminiKey,
        config.model,
        config.maxTokens,
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      );
    }
    case "openrouter":
      return new OpenRouterProvider(
        requireEnvVar("OPENROUTER_API_KEY"),
        config.model,
        config.maxTokens,
        "https://openrouter.ai/api/v1/chat/completions",
      );
    case "openai": {
      const openaiKey = getEnvVar("OPENAI_API_KEY");
      if (!openaiKey) {
        throw new Error(
          "OPENAI_API_KEY is required for the openai provider",
        );
      }
      return new OpenAIProvider(
        openaiKey,
        config.model,
        config.maxTokens,
        config.baseURL,
      );
    }
    case "noop":
      return new NoopProvider();
    case "agent-sdk":
    default:
      return new AgentSDKProvider();
  }
}
