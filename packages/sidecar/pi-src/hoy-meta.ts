import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const META_PROVIDER_ID = "meta" as const;

export const META_MODEL: ProviderModelConfig = {
  id: "muse-spark-1.1",
  name: "Muse Spark 1.1",
  reasoning: true,
  // pdf/video inputs are not representable in Pi's ("text" | "image")[] union;
  // clamped to image until Pi's Model.input union is extended.
  input: ["text", "image"],
  // Display-only placeholder, same convention as hoy-alibaba (cost 0).
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  // "off" is unsupported by Muse Spark (HTTP 400); xhigh is its max effort and
  // Pi only exposes it when mapped. Unmapped levels pass through as-is.
  thinkingLevelMap: { off: null, xhigh: "xhigh" },
};

// Static Hoy-owned provider, same registration contract as createHoyAlibaba but
// with a fixed single-model catalog, so no fetch/cache layer is needed. Pi gates
// get_available_models by configured auth, so the model stays hidden until an
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
      models: [META_MODEL],
    });
  };
}
