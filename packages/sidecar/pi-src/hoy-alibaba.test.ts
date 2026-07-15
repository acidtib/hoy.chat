import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALIBABA_PROVIDERS,
  buildModels,
  createHoyAlibaba,
  DEFAULT_ALIBABA_ENDPOINTS,
  modelFromId,
} from "./hoy-alibaba";

const scratch: string[] = [];
const originalFetch = globalThis.fetch;

function tempDir(tag: string): string {
  const dir = join("/tmp", `hoy-alibaba-${tag}-${process.pid}-${scratch.length}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Alibaba model metadata", () => {
  test("filters routing metadata into the supported Pi APIs", () => {
    const endpoints = DEFAULT_ALIBABA_ENDPOINTS["alibaba-cloud"];
    const models = buildModels(
      [modelFromId("qwen3.7-plus"), modelFromId("deepseek-v3.2"), modelFromId("unknown-chat")],
      endpoints,
    );
    expect(models[0].api).toBe("anthropic-messages");
    expect(models[0].input).toEqual(["text", "image"]);
    expect(models[0].reasoning).toBe(true);
    expect(models[0].contextWindow).toBe(1_048_576);
    expect(models[1].api).toBe("openai-completions");
    expect(models[1].baseUrl).toBe(endpoints.openAiBaseUrl);
    expect(models[2].reasoning).toBe(false);
    expect(models[2].input).toEqual(["text"]);
    expect(models[2].contextWindow).toBe(131_072);
  });
});

describe("createHoyAlibaba", () => {
  test("fetches configured providers and registers all provider ids", async () => {
    const dir = tempDir("fetch");
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ "alibaba-cloud": { type: "api_key", key: "secret-value" } }),
    );
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "qwen3.7-plus" },
            { id: "text-embedding-v4" },
            { id: "wan2.7-image" },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const registered: Array<{
      id: string;
      config: { apiKey?: string; models?: unknown[] };
    }> = [];
    await createHoyAlibaba(dir)({
      registerProvider: (id: string, config: { models?: unknown[] }) => registered.push({ id, config }),
    } as never);
    expect(registered.map((item) => item.id)).toEqual([...ALIBABA_PROVIDERS]);
    expect(registered[0].config.apiKey).toBe("$DASHSCOPE_API_KEY");
    expect(registered[0].config.models).toHaveLength(1);
    expect(registered[1].config.models).toHaveLength(0);
    expect(readFileSync(join(dir, "provider-models-cache.json"), "utf8")).not.toContain("secret-value");
  });

  test("uses only a cache whose endpoint pair still matches", async () => {
    const dir = tempDir("cache");
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ "alibaba-cloud": { type: "api_key", key: "secret" } }),
    );
    const endpoints = DEFAULT_ALIBABA_ENDPOINTS["alibaba-cloud"];
    writeFileSync(
      join(dir, "provider-models-cache.json"),
      JSON.stringify({
        providers: {
          "alibaba-cloud": {
            fetchedAt: Date.now(),
            endpoints: {
              openai: endpoints.openAiBaseUrl,
              anthropic: endpoints.anthropicBaseUrl,
            },
            models: [modelFromId("cached-model")],
          },
        },
      }),
    );
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const registered: Array<{ id: string; config: { models?: Array<{ id: string }> } }> = [];
    await createHoyAlibaba(dir)({
      registerProvider: (id: string, config: { models?: Array<{ id: string }> }) =>
        registered.push({ id, config }),
    } as never);
    expect(registered[0].config.models?.[0].id).toBe("cached-model");
    expect(fetches).toBe(0);

    writeFileSync(
      join(dir, "providers.json"),
      JSON.stringify({
        providers: {
          "alibaba-cloud": {
            endpoints: {
              openai: "https://custom.example/v1",
              anthropic: "https://custom.example/anthropic",
            },
          },
        },
      }),
    );
    registered.length = 0;
    await createHoyAlibaba(dir)({
      registerProvider: (id: string, config: { models?: Array<{ id: string }> }) =>
        registered.push({ id, config }),
    } as never);
    expect(registered[0].config.models).toHaveLength(0);
    expect(fetches).toBe(1);
  });

  test("registers a stale cache without awaiting its refresh", async () => {
    const dir = tempDir("stale-cache");
    const endpoints = DEFAULT_ALIBABA_ENDPOINTS["alibaba-cloud"];
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ "alibaba-cloud": { type: "api_key", key: "secret" } }),
    );
    writeFileSync(
      join(dir, "provider-models-cache.json"),
      JSON.stringify({
        providers: {
          "alibaba-cloud": {
            fetchedAt: 1,
            endpoints: {
              openai: endpoints.openAiBaseUrl,
              anthropic: endpoints.anthropicBaseUrl,
            },
            models: [modelFromId("cached-model")],
          },
        },
      }),
    );
    let finishRefresh!: (response: Response) => void;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        finishRefresh = resolve;
      })) as unknown as typeof fetch;
    const registered: Array<{ id: string; config: { models?: Array<{ id: string }> } }> = [];

    await createHoyAlibaba(dir)({
      registerProvider: (id: string, config: { models?: Array<{ id: string }> }) =>
        registered.push({ id, config }),
    } as never);

    expect(registered[0].config.models?.[0].id).toBe("cached-model");
    finishRefresh(new Response(JSON.stringify({ data: [{ id: "refreshed-model" }] }), { status: 200 }));
    await Bun.sleep(10);
    expect(readFileSync(join(dir, "provider-models-cache.json"), "utf8")).toContain("refreshed-model");
  });
});
