import { describe, expect, test } from "bun:test";
import {
  FEATURED,
  OAUTH_PROVIDERS,
  PROVIDER_META,
  metaFor,
} from "@/components/settings/providerMeta";

describe("FEATURED", () => {
  test("lists the 8 featured providers in display order", () => {
    expect(FEATURED).toEqual([
      "anthropic",
      "openai",
      "openrouter",
      "google",
      "xai",
      "deepseek",
      "mistral",
      "groq",
    ]);
  });

  test("every featured provider has full metadata", () => {
    for (const id of FEATURED) {
      const meta = PROVIDER_META[id];
      expect(meta).toBeDefined();
      expect(meta.description.length).toBeGreaterThan(0);
      expect(meta.consoleUrl).toStartWith("https://");
      expect(meta.placeholder.length).toBeGreaterThan(0);
    }
  });

  test("anthropic metadata matches the plan", () => {
    expect(PROVIDER_META.anthropic).toEqual({
      description: "Claude models from Anthropic",
      consoleUrl: "https://console.anthropic.com/settings/keys",
      placeholder: "sk-ant-xxxxxxxx",
    });
  });
});

describe("metaFor", () => {
  test("returns the curated entry for a featured id", () => {
    expect(metaFor("google", "Google Gemini")).toBe(PROVIDER_META.google);
  });

  test("falls back for unknown providers: label description, no console link", () => {
    const meta = metaFor("zai", "ZAI");
    expect(meta.description).toBe("ZAI models via API key.");
    expect(meta.consoleUrl).toBeUndefined();
    expect(meta.placeholder).toBe("Paste API key");
  });
});

describe("OAUTH_PROVIDERS", () => {
  test("two mock rows: Claude Pro/Max and ChatGPT", () => {
    expect(OAUTH_PROVIDERS.map((p) => p.label)).toEqual([
      "Claude Pro/Max",
      "ChatGPT",
    ]);
    for (const p of OAUTH_PROVIDERS) {
      expect(p.description.length).toBeGreaterThan(0);
    }
  });
});
