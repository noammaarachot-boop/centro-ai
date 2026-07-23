import type { LanguageModel } from "ai";
import { getAiCoreConfig } from "../config";
import type { AiProvider } from "./types";

export class AiProviderNotConfiguredError extends Error {
  constructor(provider: AiProvider) {
    super(
      `AI provider "${provider}" has no API key configured. Set ${envVarFor(provider)}, or omit the provider argument to use whichever configured provider is the default.`
    );
  }
}

export class NoAiProviderConfiguredError extends Error {
  constructor() {
    super(
      "No AI provider is configured. Set at least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY."
    );
  }
}

function envVarFor(provider: AiProvider): string {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "google":
      return "GOOGLE_GENERATIVE_AI_API_KEY";
  }
}

// Lazy `import()` per provider package, mirroring src/db/index.ts's
// lazy-loaded drivers — a provider package is never even imported unless
// a caller actually resolves that provider, so an unconfigured provider
// costs nothing at startup.
async function createModel(provider: AiProvider, apiKey: string, modelId: string): Promise<LanguageModel> {
  switch (provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey })(modelId);
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ apiKey })(modelId);
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      return createGoogleGenerativeAI({ apiKey })(modelId);
    }
  }
}

// The one place this integration throws over a missing key — never
// getAiCoreConfig() itself (see its own doc comment), only here, at the
// moment a caller actually needs a working model and the provider they
// asked for (explicitly, or via the resolved default) has no key.
export async function resolveLanguageModel(provider?: AiProvider): Promise<LanguageModel> {
  const config = getAiCoreConfig();
  const resolvedProvider = provider ?? config.defaultProvider;

  if (!resolvedProvider) {
    throw new NoAiProviderConfiguredError();
  }
  const apiKey = config.apiKeys[resolvedProvider];
  if (!apiKey) {
    throw new AiProviderNotConfiguredError(resolvedProvider);
  }

  return createModel(resolvedProvider, apiKey, config.models[resolvedProvider]);
}
