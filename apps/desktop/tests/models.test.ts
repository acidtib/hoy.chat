import { describe, expect, test } from "bun:test";
import {
  modelKey,
  resolveDefaultModel,
  setModelsEnabled,
  visibleModels,
} from "@/lib/models";
import type { ModelInfo } from "@/lib/types";

const opus: ModelInfo = { provider: "anthropic", id: "opus", name: "Opus" };
const haiku: ModelInfo = { provider: "anthropic", id: "haiku", name: "Haiku" };
const gpt: ModelInfo = { provider: "openai", id: "gpt", name: "GPT" };
const all = [opus, haiku, gpt];

describe("visibleModels", () => {
  test("hides disabled models", () => {
    expect(visibleModels(all, [modelKey(haiku)])).toEqual([opus, gpt]);
  });

  test("keeps the current pick even when disabled", () => {
    expect(visibleModels(all, [modelKey(haiku)], haiku)).toEqual(all);
  });
});

describe("resolveDefaultModel", () => {
  const pi = { provider: "openai", id: "gpt" };

  test("prefers the preferred model when it is available", () => {
    expect(resolveDefaultModel(opus, all, pi)).toEqual(opus);
  });

  test("falls back to Pi's pick when the preferred model is gone", () => {
    expect(resolveDefaultModel({ provider: "x", id: "y" }, all, pi)).toEqual(pi);
  });

  test("trusts the preferred model before models load", () => {
    expect(resolveDefaultModel(opus, [], pi)).toEqual(opus);
  });

  test("no preference uses Pi's pick", () => {
    expect(resolveDefaultModel(null, all, pi)).toEqual(pi);
  });
});

describe("setModelsEnabled", () => {
  test("turns models off and back on", () => {
    const off = setModelsEnabled([], [modelKey(opus), modelKey(gpt)], false);
    expect(off.sort()).toEqual(["anthropic/opus", "openai/gpt"]);
    expect(setModelsEnabled(off, [modelKey(gpt)], true)).toEqual(["anthropic/opus"]);
  });
});
