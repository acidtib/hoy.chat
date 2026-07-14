// Static display metadata for the Providers panel. Pure data, no IPC. The
// canonical provider list (ids, labels, env vars) comes from the backend via
// supportedProviders(); this module only decorates it for display.

import type { ProviderAuth, ProviderInfo } from "@/lib/types";
import { SUBSCRIPTION_PROVIDER_IDS } from "@/lib/providerIds";

export interface ProviderMeta {
  description: string;
  // Key console URL, opened in the system browser. Absent for non-featured
  // providers; the console step is omitted when missing.
  consoleUrl?: string;
  consoleLabel?: string;
  placeholder: string;
}

// Featured providers, in display order.
export const FEATURED: string[] = [
  "anthropic",
  "openai",
  "openrouter",
  "google",
  "xai",
  "deepseek",
  "mistral",
  "groq",
];

export const PROVIDER_META: Record<string, ProviderMeta> = {
  anthropic: {
    description: "Claude models from Anthropic",
    consoleUrl: "https://console.anthropic.com/settings/keys",
    placeholder: "sk-ant-xxxxxxxx",
  },
  openai: {
    description: "GPT and o-series models from OpenAI",
    consoleUrl: "https://platform.openai.com/api-keys",
    placeholder: "sk-proj-xxxxxxxx",
  },
  openrouter: {
    description: "One key for hundreds of models across providers",
    consoleUrl: "https://openrouter.ai/settings/keys",
    placeholder: "sk-or-v1-xxxxxxxx",
  },
  google: {
    description: "Gemini models from Google AI Studio",
    consoleUrl: "https://aistudio.google.com/apikey",
    placeholder: "AIzaSyxxxxxxxx",
  },
  xai: {
    description: "Grok models from xAI",
    consoleUrl: "https://console.x.ai/team/default/api-keys",
    placeholder: "xai-xxxxxxxx",
  },
  deepseek: {
    description: "DeepSeek chat and reasoner models",
    consoleUrl: "https://platform.deepseek.com/api_keys",
    placeholder: "sk-xxxxxxxx",
  },
  mistral: {
    description: "Mistral and Codestral models",
    consoleUrl: "https://console.mistral.ai/api-keys",
    placeholder: "Paste API key",
  },
  groq: {
    description: "Ultra-fast inference for open models",
    consoleUrl: "https://console.groq.com/keys",
    placeholder: "gsk_xxxxxxxx",
  },
};

export function metaFor(id: string, label: string): ProviderMeta {
  return (
    PROVIDER_META[id] ?? {
      description: `${label} models via API key.`,
      placeholder: "Paste API key",
    }
  );
}

// Two-letter monogram for a provider mark. Splits on spaces and separators so
// multi-word labels read as initials ("Google Gemini" -> "GG"), single words
// fall back to their first two letters ("DeepSeek" -> "DE").
export function initialsFor(label: string): string {
  const words = label.replace(/[/&·]+/g, " ").split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return label.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";
}

// List partition for the panel: configured pinned on top, then the featured
// set, then everything else alphabetically. Within each group, featured ids
// keep FEATURED order and the rest sort by label.
export function partitionProviders(
  providers: ProviderInfo[],
  auth: ProviderAuth[],
): {
  configured: ProviderInfo[];
  featured: ProviderInfo[];
  rest: ProviderInfo[];
} {
  const configuredIds = new Set(
    auth.filter((a) => a.configured).map((a) => a.provider),
  );
  const rank = (p: ProviderInfo) => {
    const i = FEATURED.indexOf(p.id);
    return i === -1 ? FEATURED.length : i;
  };
  const order = (a: ProviderInfo, b: ProviderInfo) =>
    rank(a) - rank(b) || a.label.localeCompare(b.label);

  const configured = providers.filter((p) => configuredIds.has(p.id)).sort(order);
  const unconfigured = providers.filter((p) => !configuredIds.has(p.id));
  const featured = unconfigured
    .filter((p) => FEATURED.includes(p.id))
    .sort(order);
  const rest = unconfigured
    .filter((p) => !FEATURED.includes(p.id))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { configured, featured, rest };
}

// Subscription sign-in options, one per Pi OAuth provider (pi-ai/oauth). `id`
// is Pi's OAuth provider id, which is also the auth.json key written on login,
// so a configured status can be matched back to a row by provider id. The
// Connect flow (manual paste of the redirect code) is wired in a follow-up; the
// backend command does not exist yet.
export interface SubscriptionProvider {
  id: string;
  label: string;
  subtitle: string;
  // Brand glyph slug (providerIcons). The subscription mark differs from the
  // api-key row: "anthropic" login is the Claude subscription, so it wears the
  // Claude mark, not the Anthropic corporate mark.
  glyph?: string;
}

export const SUBSCRIPTION_PROVIDERS: SubscriptionProvider[] = [
  {
    id: SUBSCRIPTION_PROVIDER_IDS[0],
    label: "Claude Pro / Max",
    subtitle: "Use your Anthropic subscription, no API key needed",
    glyph: "claude",
  },
  {
    id: SUBSCRIPTION_PROVIDER_IDS[1],
    label: "ChatGPT",
    subtitle: "Sign in with your OpenAI plan",
    glyph: "openai",
  },
  {
    id: SUBSCRIPTION_PROVIDER_IDS[2],
    label: "GitHub Copilot",
    subtitle: "Bring your Copilot subscription",
    glyph: "copilot",
  },
  {
    id: SUBSCRIPTION_PROVIDER_IDS[3],
    label: "Radius",
    subtitle: "Sign in with Radius",
  },
];
