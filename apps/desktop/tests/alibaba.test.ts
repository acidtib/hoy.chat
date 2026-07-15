import { describe, expect, test } from "bun:test";
import {
  apiHostFromSettings,
  endpointsFromApiHost,
} from "@/lib/alibaba";

describe("Alibaba API Host mapping", () => {
  test("derives every workspace endpoint from the host shown by Model Studio", () => {
    const endpoints = endpointsFromApiHost(
      "alibaba-cloud",
      "ws-example.ap-southeast-1.maas.aliyuncs.com",
    );
    expect(endpoints).toEqual({
      apiHost: "https://ws-example.ap-southeast-1.maas.aliyuncs.com",
      openAiBaseUrl:
        "https://ws-example.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      anthropicBaseUrl:
        "https://ws-example.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
      dashscopeBaseUrl:
        "https://ws-example.ap-southeast-1.maas.aliyuncs.com/api/v1",
    });
  });

  test("uses Coding Plan's shorter OpenAI path", () => {
    expect(
      endpointsFromApiHost(
        "alibaba-coding-plan",
        "https://coding-intl.dashscope.aliyuncs.com",
      ).openAiBaseUrl,
    ).toBe("https://coding-intl.dashscope.aliyuncs.com/v1");
  });

  test("recovers the API Host from resolved endpoint settings", () => {
    expect(
      apiHostFromSettings({
        provider: "alibaba-cloud",
        openAiBaseUrl: "https://workspace.example/compatible-mode/v1",
        anthropicBaseUrl: "https://workspace.example/apps/anthropic",
        usingDefaults: false,
      }),
    ).toBe("https://workspace.example");
  });
});
