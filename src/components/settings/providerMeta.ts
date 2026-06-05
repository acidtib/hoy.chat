// Static display metadata for the Providers panel. Pure data, no IPC. The
// canonical provider list (ids, labels, env vars) comes from the backend via
// supportedProviders(); this module only decorates it for display.

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

// Non-functional OAuth rows shown above the API-key list. Mock only; the
// Connect buttons are disabled with a "Coming soon" badge.
export const OAUTH_PROVIDERS: { id: string; label: string; description: string }[] = [
  { id: "claude-oauth", label: "Claude Pro/Max", description: "Anthropic subscription" },
  { id: "chatgpt-oauth", label: "ChatGPT", description: "OpenAI subscription" },
];
