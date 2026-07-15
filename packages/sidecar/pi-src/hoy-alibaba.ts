import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ALIBABA_PROVIDERS = [
  "alibaba-cloud",
  "alibaba-coding-plan",
  "alibaba-token-plan",
] as const;

export type AlibabaProviderId = (typeof ALIBABA_PROVIDERS)[number];

interface EndpointPair {
  openAiBaseUrl: string;
  anthropicBaseUrl: string;
}

interface StoredEndpoints {
  openai: string;
  anthropic: string;
}

interface ProviderEntry {
  endpoints: StoredEndpoints;
}

interface ProviderConfig {
  providers?: Partial<Record<AlibabaProviderId, ProviderEntry>>;
}

interface CacheEntry {
  fetchedAt: number;
  endpoints: StoredEndpoints;
  models: ProviderModelConfig[];
}

interface AlibabaCache {
  providers?: Partial<Record<AlibabaProviderId, CacheEntry>>;
}

interface AuthEntry {
  type?: string;
  key?: string;
  access?: string;
}

type AuthFile = Record<string, AuthEntry>;

export const DEFAULT_ALIBABA_ENDPOINTS: Record<AlibabaProviderId, EndpointPair> = {
  "alibaba-cloud": {
    openAiBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    anthropicBaseUrl: "https://dashscope-intl.aliyuncs.com/apps/anthropic",
  },
  "alibaba-coding-plan": {
    openAiBaseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
    anthropicBaseUrl: "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic",
  },
  "alibaba-token-plan": {
    openAiBaseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    anthropicBaseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
  },
};

const PROVIDER_NAMES: Record<AlibabaProviderId, string> = {
  "alibaba-cloud": "Alibaba Cloud Model Studio",
  "alibaba-coding-plan": "Alibaba Coding Plan",
  "alibaba-token-plan": "Alibaba Token Plan",
};

const PROVIDER_API_KEY_FALLBACKS: Record<AlibabaProviderId, string> = {
  "alibaba-cloud": "$DASHSCOPE_API_KEY",
  "alibaba-coding-plan": "$ALIBABA_CODING_PLAN_API_KEY",
  "alibaba-token-plan": "$ALIBABA_TOKEN_PLAN_API_KEY",
};

const EXCLUDED_MODEL = /(image|audio|video|tts|asr|embed|vector|rerank|wan|omni|livetranslate|realtime)/i;
const VISION_MODEL = /(?:vl|vision)/i;
const REASONING_MODEL = /(?:qwq|\bmax\b|thinking|deepseek|minimax|kimi|glm|qwen3\.[5-9])/i;
const CACHE_MAX_AGE_MS = 60 * 60 * 1_000;

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function endpointPair(config: ProviderConfig, provider: AlibabaProviderId): EndpointPair {
  const stored = config.providers?.[provider]?.endpoints;
  return stored
    ? { openAiBaseUrl: stored.openai, anthropicBaseUrl: stored.anthropic }
    : DEFAULT_ALIBABA_ENDPOINTS[provider];
}

function storedEndpoints(endpoints: EndpointPair): StoredEndpoints {
  return { openai: endpoints.openAiBaseUrl, anthropic: endpoints.anthropicBaseUrl };
}

function apiKey(entry?: AuthEntry): string | undefined {
  const value = entry?.type === "oauth" ? entry.access : entry?.key;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function prettyName(id: string): string {
  if (/^qwen/i.test(id)) {
    return id
      .replace(/^qwen/i, "Qwen ")
      .replace(/-/g, " ")
      .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  }
  if (/^glm/i.test(id)) return id.toUpperCase();
  if (/^kimi/i.test(id)) return id.replace(/^kimi/i, "Kimi").replace(/-/g, " ");
  if (/^deepseek/i.test(id)) return id.replace(/^deepseek/i, "DeepSeek").replace(/-/g, " ");
  return id.replace(/-/g, " ");
}

function inferContextWindow(id: string): number {
  if (/kimi/i.test(id)) return 262_144;
  if (/^qwen3\.6-max\b/i.test(id)) return 1_048_576;
  if (/^qwen3\.6-plus\b/i.test(id) || /^qwen3\.([7-9]|\d{2,})-(?:plus|max)\b/i.test(id)) {
    return 1_048_576;
  }
  return 131_072;
}

export function modelFromId(id: string, name?: string): ProviderModelConfig {
  const reasoning = REASONING_MODEL.test(id);
  const vision = VISION_MODEL.test(id) || /^qwen3\.[5-9]-plus\b/i.test(id) || /kimi/i.test(id);
  return {
    id,
    name: name || prettyName(id),
    reasoning,
    input: vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: inferContextWindow(id),
    maxTokens: /deepseek|^qwen3\.[5-9]|^qwen-max\b|kimi|glm/i.test(id) ? 16_384 : 8_192,
    compat: reasoning && !/deepseek/i.test(id) ? { thinkingFormat: "qwen" } : undefined,
    thinkingLevelMap: reasoning ? { off: null } : undefined,
  };
}

export function buildModels(models: ProviderModelConfig[], endpoints: EndpointPair): ProviderModelConfig[] {
  return models.map((model) => {
    const openAi = /deepseek/i.test(model.id);
    return {
      ...model,
      api: openAi ? "openai-completions" : "anthropic-messages",
      baseUrl: openAi ? endpoints.openAiBaseUrl : endpoints.anthropicBaseUrl,
    };
  });
}

async function fetchModels(endpoints: EndpointPair, key: string): Promise<ProviderModelConfig[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${endpoints.openAiBaseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { data?: Array<{ id?: string; name?: string }> };
    return (body.data ?? [])
      .filter((model): model is { id: string; name?: string } =>
        typeof model.id === "string" && model.id.length > 0 && !EXCLUDED_MODEL.test(model.id),
      )
      .map((model) => modelFromId(model.id, model.name));
  } finally {
    clearTimeout(timeout);
  }
}

function sameEndpoints(a: StoredEndpoints, b: EndpointPair): boolean {
  return a.openai === b.openAiBaseUrl && a.anthropic === b.anthropicBaseUrl;
}

export function createHoyAlibaba(agentDir: string) {
  return async (pi: ExtensionAPI) => {
    const configPath = join(agentDir, "providers.json");
    const cachePath = join(agentDir, "provider-models-cache.json");
    const config = readJson<ProviderConfig>(configPath, {});
    const auth = readJson<AuthFile>(join(agentDir, "auth.json"), {});
    const cache = readJson<AlibabaCache>(cachePath, {});
    const refreshes: Array<{ provider: AlibabaProviderId; endpoints: EndpointPair; key: string }> = [];

    const loaded = await Promise.all(
      ALIBABA_PROVIDERS.map(async (provider) => {
        const endpoints = endpointPair(config, provider);
        const key = apiKey(auth[provider]);
        if (!key) return { provider, endpoints, models: [] as ProviderModelConfig[], fresh: false };
        const prior = cache.providers?.[provider];
        if (prior?.models.length && sameEndpoints(prior.endpoints, endpoints)) {
          if (Date.now() - prior.fetchedAt >= CACHE_MAX_AGE_MS || Date.now() < prior.fetchedAt) {
            refreshes.push({ provider, endpoints, key });
          }
          return { provider, endpoints, models: prior.models, fresh: false };
        }
        try {
          const models = await fetchModels(endpoints, key);
          if (models.length === 0) throw new Error("catalog contained no chat models");
          return { provider, endpoints, models, fresh: true };
        } catch (error) {
          console.warn(`[alibaba] ${provider} catalog unavailable: ${error instanceof Error ? error.message : String(error)}`);
          return { provider, endpoints, models: [] as ProviderModelConfig[], fresh: false };
        }
      }),
    );

    const nextCache: AlibabaCache = { providers: { ...cache.providers } };
    for (const item of loaded) {
      if (item.fresh && item.models.length > 0) {
        nextCache.providers![item.provider] = {
          fetchedAt: Date.now(),
          endpoints: storedEndpoints(item.endpoints),
          models: item.models,
        };
      }
      pi.registerProvider(item.provider, {
        name: PROVIDER_NAMES[item.provider],
        // Pi 0.80.7 requires apiKey or oauth when an extension registers models.
        // Stored auth.json credentials resolve first; this fallback is never
        // injected into Hoy's sanitized sidecar environment.
        apiKey: PROVIDER_API_KEY_FALLBACKS[item.provider],
        api: "anthropic-messages",
        baseUrl: item.endpoints.anthropicBaseUrl,
        authHeader: true,
        models: buildModels(item.models, item.endpoints),
      });
    }
    // Purge stale cache entries whose endpoints changed but whose fetch
    // failed, then always persist so stale data doesn't survive a restart.
    for (const item of loaded) {
      if (!item.fresh) {
        const prior = cache.providers?.[item.provider];
        if (prior && !sameEndpoints(prior.endpoints, item.endpoints)) {
          if (nextCache.providers) delete nextCache.providers[item.provider];
        }
      }
    }
    writeJsonAtomic(cachePath, nextCache);
    if (refreshes.length > 0) {
      void Promise.all(
        refreshes.map(async ({ provider, endpoints, key }) => {
          try {
            const models = await fetchModels(endpoints, key);
            if (models.length === 0) throw new Error("catalog contained no chat models");
            return { provider, endpoints, models };
          } catch (error) {
            console.warn(
              `[alibaba] ${provider} background catalog refresh unavailable: ${error instanceof Error ? error.message : String(error)}`,
            );
            return undefined;
          }
        }),
      ).then((results) => {
        const refreshed = results.filter((result) => result !== undefined);
        if (refreshed.length === 0) return;
        const latest = readJson<AlibabaCache>(cachePath, {});
        latest.providers ??= {};
        for (const item of refreshed) {
          latest.providers[item.provider] = {
            fetchedAt: Date.now(),
            endpoints: storedEndpoints(item.endpoints),
            models: item.models,
          };
        }
        writeJsonAtomic(cachePath, latest);
      }).catch((error) => {
        console.warn(
          `[alibaba] background cache write failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  };
}
