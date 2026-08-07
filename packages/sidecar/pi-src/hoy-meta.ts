import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const META_PROVIDER_ID = "meta" as const;

// Shared across the family per https://dev.meta.ai/docs/models: "all three IDs
// serve the Muse Spark family and share modalities and a 1,048,576-token
// context window." Max output tokens and reasoning support are not documented
// per-model there; carried over from the original muse-spark-1.1 contract
// since the docs don't call out a difference.
const MUSE_SPARK_SHARED: Pick<
  ProviderModelConfig,
  "reasoning" | "input" | "contextWindow" | "maxTokens" | "thinkingLevelMap"
> = {
  reasoning: true,
  // pdf/video inputs are not representable in Pi's ("text" | "image")[] union;
  // clamped to image until Pi's Model.input union is extended.
  input: ["text", "image"],
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  // "off" is unsupported by Muse Spark (HTTP 400); xhigh is its max effort and
  // Pi only exposes it when mapped. Unmapped levels pass through as-is.
  thinkingLevelMap: { off: null, xhigh: "xhigh" },
};

// Pricing from https://dev.meta.ai/docs/pricing-rate-limits (USD per 1M
// tokens). No cache-write rate is published, so cacheWrite stays 0.
const STANDARD_COST = { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 };
const CONTRIBUTOR_COST = { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 };

export const META_MODEL: ProviderModelConfig = {
  ...MUSE_SPARK_SHARED,
  id: "muse-spark-1.1",
  name: "Muse Spark 1.1",
  cost: STANDARD_COST,
};

export const META_MODEL_1_2: ProviderModelConfig = {
  ...MUSE_SPARK_SHARED,
  id: "muse-spark-1.2",
  name: "Muse Spark 1.2",
  cost: STANDARD_COST,
};

export const META_MODEL_1_2_CONTRIBUTOR: ProviderModelConfig = {
  ...MUSE_SPARK_SHARED,
  id: "muse-spark-1.2-contributor",
  name: "Muse Spark 1.2 Contributor",
  cost: CONTRIBUTOR_COST,
};

export const META_MODELS: ProviderModelConfig[] = [
  META_MODEL,
  META_MODEL_1_2,
  META_MODEL_1_2_CONTRIBUTOR,
];

// Static Hoy-owned provider, same registration contract as createHoyAlibaba but
// with a fixed model catalog, so no fetch/cache layer is needed. Pi gates
// get_available_models by configured auth, so models stay hidden until an
// auth.json entry exists (or META_API_KEY is injected).
export function createHoyMeta() {
  return async (pi: ExtensionAPI) => {
    pi.registerProvider(META_PROVIDER_ID, {
      name: "Meta Model API",
      api: "openai-responses",
      baseUrl: "https://api.meta.ai/v1",
      // Pi resolves $VAR at request time when no auth.json entry exists; never
      // injected into Hoy's sanitized sidecar environment.
      apiKey: "$META_API_KEY",
      authHeader: true,
      models: META_MODELS,
    });
  };
}
