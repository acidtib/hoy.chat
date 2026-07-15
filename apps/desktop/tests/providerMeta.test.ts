import { describe, expect, test } from "bun:test";
import {
  FEATURED,
  SUBSCRIPTION_PROVIDERS,
  PROVIDER_META,
  initialsFor,
  metaFor,
  partitionProviders,
} from "@/components/settings/providerMeta";
import type { ProviderAuth, ProviderInfo } from "@/lib/types";

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

describe("Alibaba providers", () => {
  test("each Hoy-owned provider has connection metadata", () => {
    for (const id of [
      "alibaba-cloud",
      "alibaba-coding-plan",
      "alibaba-token-plan",
    ]) {
      const meta = PROVIDER_META[id];
      expect(meta.description.length).toBeGreaterThan(0);
      expect(meta.consoleUrl).toStartWith("https://");
      expect(meta.placeholder.length).toBeGreaterThan(0);
    }
  });
});

describe("partitionProviders", () => {
  const p = (id: string, label: string): ProviderInfo => ({
    id,
    label,
    env: "X",
  });
  const configured = (provider: string): ProviderAuth => ({
    provider,
    configured: true,
    kind: "api_key",
    source: "authFile",
    removable: true,
  });
  const providers = [
    p("zai", "ZAI"),
    p("google", "Google Gemini"),
    p("anthropic", "Anthropic"),
    p("minimax", "MiniMax"),
    p("groq", "Groq"),
  ];

  test("splits into configured, featured (FEATURED order), rest (alphabetical)", () => {
    const auth = [configured("google"), configured("zai")];
    const out = partitionProviders(providers, auth);
    expect(out.configured.map((x) => x.id)).toEqual(["google", "zai"]);
    expect(out.featured.map((x) => x.id)).toEqual(["anthropic", "groq"]);
    expect(out.rest.map((x) => x.id)).toEqual(["minimax"]);
  });

  test("unconfigured auth entries do not pin a provider", () => {
    const auth: ProviderAuth[] = [
      { provider: "google", configured: false, removable: false },
    ];
    const out = partitionProviders(providers, auth);
    expect(out.configured).toEqual([]);
    expect(out.featured.map((x) => x.id)).toEqual([
      "anthropic",
      "google",
      "groq",
    ]);
    expect(out.rest.map((x) => x.id)).toEqual(["minimax", "zai"]);
  });
});

describe("SUBSCRIPTION_PROVIDERS", () => {
  test("ids are Pi's OAuth provider ids (also the auth.json keys)", () => {
    expect(SUBSCRIPTION_PROVIDERS.map((p) => p.id)).toEqual([
      "anthropic",
      "openai-codex",
      "github-copilot",
      "radius",
    ]);
  });

  test("each row carries display copy and branded providers carry glyphs", () => {
    for (const p of SUBSCRIPTION_PROVIDERS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.subtitle.length).toBeGreaterThan(0);
    }
    expect(SUBSCRIPTION_PROVIDERS.slice(0, 3).every((p) => Boolean(p.glyph))).toBeTrue();
    expect(SUBSCRIPTION_PROVIDERS.find((p) => p.id === "radius")?.glyph).toBeUndefined();
  });
});

describe("initialsFor", () => {
  test("multi-word labels take the first letter of the first two words", () => {
    expect(initialsFor("Google Gemini")).toBe("GG");
    expect(initialsFor("Claude Pro / Max")).toBe("CP");
  });

  test("single-word labels take the first two letters", () => {
    expect(initialsFor("DeepSeek")).toBe("DE");
    expect(initialsFor("xAI")).toBe("XA");
    expect(initialsFor("Radius")).toBe("RA");
  });
});
