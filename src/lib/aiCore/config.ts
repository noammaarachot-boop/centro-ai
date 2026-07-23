import type { AiProvider } from "./providers/types";

// Default model per provider, used when the matching AI_CORE_*_MODEL
// override is unset. Model catalogs move fast — these are reasonable,
// currently-real defaults as of this integration's build, not a
// guarantee they remain the newest available; override via env instead
// of editing this file if a provider ships a new default model.
export const DEFAULT_MODELS: Record<AiProvider, string> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-5",
  google: "gemini-2.0-flash",
};

export interface AiCoreConfig {
  apiKeys: Partial<Record<AiProvider, string>>;
  models: Record<AiProvider, string>;
  // Which provider serves a conversation that doesn't pin one
  // explicitly. Null only if genuinely nothing is configured — callers
  // (resolveModel.ts) surface that as a clear error at the point a model
  // is actually requested, never here.
  defaultProvider: AiProvider | null;
}

// Deliberately different from googleAuth/config.ts's/whatsapp/config.ts's
// throw-if-missing shape: there is no single required variable here —
// any one of the three provider keys is enough for the copilot to work,
// and which one(s) are missing isn't an error until a caller actually
// asks to resolve a provider that has no key. See providers/
// resolveModel.ts, which is where the equivalent throw happens instead.
export function getAiCoreConfig(): AiCoreConfig {
  const apiKeys: Partial<Record<AiProvider, string>> = {};
  if (process.env.OPENAI_API_KEY) apiKeys.openai = process.env.OPENAI_API_KEY;
  if (process.env.ANTHROPIC_API_KEY) apiKeys.anthropic = process.env.ANTHROPIC_API_KEY;
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) apiKeys.google = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  const models: Record<AiProvider, string> = {
    openai: process.env.AI_CORE_OPENAI_MODEL || DEFAULT_MODELS.openai,
    anthropic: process.env.AI_CORE_ANTHROPIC_MODEL || DEFAULT_MODELS.anthropic,
    google: process.env.AI_CORE_GOOGLE_MODEL || DEFAULT_MODELS.google,
  };

  const requestedDefault = process.env.AI_CORE_DEFAULT_PROVIDER as AiProvider | undefined;
  const defaultProvider: AiProvider | null =
    requestedDefault && apiKeys[requestedDefault]
      ? requestedDefault
      : // No explicit preference (or the preferred one has no key) —
        // fall back to whichever is actually configured, preferring
        // anthropic > openai > google.
        (["anthropic", "openai", "google"] as const).find((provider) => apiKeys[provider]) ?? null;

  return { apiKeys, models, defaultProvider };
}
