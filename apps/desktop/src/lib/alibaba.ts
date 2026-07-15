import type {
  AlibabaEndpointSettings,
  AlibabaProviderId,
} from "./types";

export interface DerivedAlibabaEndpoints {
  apiHost: string;
  openAiBaseUrl: string;
  anthropicBaseUrl: string;
  dashscopeBaseUrl?: string;
}

function originOf(value: string): string {
  const trimmed = value.trim();
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return new URL(withScheme).origin;
}

export function endpointsFromApiHost(
  provider: AlibabaProviderId,
  value: string,
): DerivedAlibabaEndpoints {
  const apiHost = originOf(value);
  const openAiPath =
    provider === "alibaba-coding-plan" ? "/v1" : "/compatible-mode/v1";
  return {
    apiHost,
    openAiBaseUrl: `${apiHost}${openAiPath}`,
    anthropicBaseUrl: `${apiHost}/apps/anthropic`,
    ...(provider === "alibaba-cloud"
      ? { dashscopeBaseUrl: `${apiHost}/api/v1` }
      : null),
  };
}

export function apiHostFromSettings(
  settings: AlibabaEndpointSettings,
): string {
  try {
    return new URL(settings.openAiBaseUrl).origin;
  } catch {
    return settings.openAiBaseUrl;
  }
}
