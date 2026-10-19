import { describe, expect, test } from "bun:test";
import { getSupportedThinkingLevels, type ModelInfo } from "@/lib/types";

function model(overrides: Partial<ModelInfo>): ModelInfo {
  return {
    id: "test",
    name: "Test",
    provider: "test",
    ...overrides,
  } as ModelInfo;
}

describe("getSupportedThinkingLevels", () => {
  test("null/undefined model returns off only", () => {
    expect(getSupportedThinkingLevels(null)).toEqual(["off"]);
    expect(getSupportedThinkingLevels(undefined)).toEqual(["off"]);
  });

  test("non-reasoning model returns off only regardless of map", () => {
    expect(
      getSupportedThinkingLevels(
        model({ reasoning: false, thinkingLevelMap: { off: null } }),
      ),
    ).toEqual(["off"]);
    expect(
      getSupportedThinkingLevels(model({ reasoning: false })),
    ).toEqual(["off"]);
    expect(
      getSupportedThinkingLevels(model({ reasoning: null })),
    ).toEqual(["off"]);
  });

  test("reasoning with no map returns off..high (xhigh/max hidden)", () => {
    expect(getSupportedThinkingLevels(model({ reasoning: true }))).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(
      getSupportedThinkingLevels(
        model({ reasoning: true, thinkingLevelMap: null }),
      ),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(
      getSupportedThinkingLevels(
        model({ reasoning: true, thinkingLevelMap: {} }),
      ),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  test("Muse Spark: off blocked, xhigh exposed", () => {
    expect(
      getSupportedThinkingLevels(
        model({
          reasoning: true,
          thinkingLevelMap: { off: null, xhigh: "xhigh" },
        }),
      ),
    ).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  });

  test("Alibaba reasoning: off blocked", () => {
    expect(
      getSupportedThinkingLevels(
        model({ reasoning: true, thinkingLevelMap: { off: null } }),
      ),
    ).toEqual(["minimal", "low", "medium", "high"]);
  });

  test("xAI Grok 4.5 style: off/minimal/xhigh/max blocked, low..high only", () => {
    expect(
      getSupportedThinkingLevels(
        model({
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: null,
            max: null,
          },
        }),
      ),
    ).toEqual(["low", "medium", "high"]);
  });

  test("ZAI glm-5.2 style: minimal blocked, max exposed, xhigh hidden when unmapped", () => {
    expect(
      getSupportedThinkingLevels(
        model({
          reasoning: true,
          thinkingLevelMap: {
            minimal: null,
            low: "high",
            medium: "high",
            high: "high",
            max: "max",
          },
        }),
      ),
    ).toEqual(["off", "low", "medium", "high", "max"]);
  });

  test("xhigh/max hidden unless explicitly mapped", () => {
    // Only xhigh mapped
    expect(
      getSupportedThinkingLevels(
        model({
          reasoning: true,
          thinkingLevelMap: { xhigh: "xhigh" },
        }),
      ),
    ).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    // Only max mapped
    expect(
      getSupportedThinkingLevels(
        model({
          reasoning: true,
          thinkingLevelMap: { max: "max" },
        }),
      ),
    ).toEqual(["off", "minimal", "low", "medium", "high", "max"]);
    // Both mapped
    expect(
      getSupportedThinkingLevels(
        model({
          reasoning: true,
          thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        }),
      ),
    ).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});
