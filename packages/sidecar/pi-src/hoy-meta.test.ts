import { describe, expect, test } from "bun:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { META_MODEL, META_PROVIDER_ID, createHoyMeta } from "./hoy-meta";

describe("Muse Spark model metadata", () => {
  test("matches the provider contract", () => {
    expect(META_MODEL.id).toBe("muse-spark-1.1");
    expect(META_MODEL.name).toBe("Muse Spark 1.1");
    expect(META_MODEL.reasoning).toBe(true);
    expect(META_MODEL.input).toEqual(["text", "image"]);
    expect(META_MODEL.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(META_MODEL.contextWindow).toBe(1_048_576);
    expect(META_MODEL.maxTokens).toBe(131_072);
  });

  test("blocks off and exposes xhigh thinking levels", () => {
    const levels = getSupportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: META_MODEL.thinkingLevelMap,
    } as never);
    expect(levels).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  });
});

describe("createHoyMeta", () => {
  test("registers the static Meta provider with a single model and no fetch", async () => {
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
      expect(entry.config.models).toEqual([META_MODEL]);
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
