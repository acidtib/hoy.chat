import { describe, expect, test } from "bun:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  META_MODEL,
  META_MODEL_1_2,
  META_MODEL_1_2_CONTRIBUTOR,
  META_MODELS,
  META_PROVIDER_ID,
  createHoyMeta,
} from "./hoy-meta";

describe("Muse Spark model metadata", () => {
  test("muse-spark-1.1 matches the provider contract", () => {
    expect(META_MODEL.id).toBe("muse-spark-1.1");
    expect(META_MODEL.name).toBe("Muse Spark 1.1");
    expect(META_MODEL.reasoning).toBe(true);
    expect(META_MODEL.input).toEqual(["text", "image"]);
    expect(META_MODEL.cost).toEqual({ input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 });
    expect(META_MODEL.contextWindow).toBe(1_048_576);
    expect(META_MODEL.maxTokens).toBe(131_072);
  });

  test("muse-spark-1.2 shares the standard tier pricing and limits", () => {
    expect(META_MODEL_1_2.id).toBe("muse-spark-1.2");
    expect(META_MODEL_1_2.name).toBe("Muse Spark 1.2");
    expect(META_MODEL_1_2.reasoning).toBe(true);
    expect(META_MODEL_1_2.input).toEqual(["text", "image"]);
    expect(META_MODEL_1_2.cost).toEqual({ input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 });
    expect(META_MODEL_1_2.contextWindow).toBe(1_048_576);
    expect(META_MODEL_1_2.maxTokens).toBe(131_072);
  });

  test("muse-spark-1.2-contributor uses the discounted contributor tier pricing", () => {
    expect(META_MODEL_1_2_CONTRIBUTOR.id).toBe("muse-spark-1.2-contributor");
    expect(META_MODEL_1_2_CONTRIBUTOR.name).toBe("Muse Spark 1.2 Contributor");
    expect(META_MODEL_1_2_CONTRIBUTOR.reasoning).toBe(true);
    expect(META_MODEL_1_2_CONTRIBUTOR.input).toEqual(["text", "image"]);
    expect(META_MODEL_1_2_CONTRIBUTOR.cost).toEqual({
      input: 0.1,
      output: 0.2,
      cacheRead: 0.002,
      cacheWrite: 0,
    });
    expect(META_MODEL_1_2_CONTRIBUTOR.contextWindow).toBe(1_048_576);
    expect(META_MODEL_1_2_CONTRIBUTOR.maxTokens).toBe(131_072);
  });

  test("blocks off and exposes xhigh thinking levels for every model", () => {
    for (const model of META_MODELS) {
      const levels = getSupportedThinkingLevels({
        reasoning: true,
        thinkingLevelMap: model.thinkingLevelMap,
      } as never);
      expect(levels).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    }
  });
});

describe("createHoyMeta", () => {
  test("registers the static Meta provider with all three models and no fetch", async () => {
    let fetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("unexpected fetch");
    }) as unknown as typeof fetch;
    try {
      const registered: Array<{
        id: string;
        config: {
          name?: string;
          api?: string;
          baseUrl?: string;
          apiKey?: string;
          authHeader?: boolean;
          models?: unknown[];
        };
      }> = [];
      await createHoyMeta()({
        registerProvider: (id: string, config: { models?: unknown[] }) => registered.push({ id, config }),
      } as never);
      expect(registered).toHaveLength(1);
      const [entry] = registered;
      expect(entry.id).toBe(META_PROVIDER_ID);
      expect(entry.config.name).toBe("Meta Model API");
      expect(entry.config.api).toBe("openai-responses");
      expect(entry.config.baseUrl).toBe("https://api.meta.ai/v1");
      expect(entry.config.apiKey).toBe("$META_API_KEY");
      expect(entry.config.authHeader).toBe(true);
      expect(entry.config.models).toEqual(META_MODELS);
      expect(entry.config.models).toHaveLength(3);
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
