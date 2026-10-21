// Model visibility and the app default model, driven by the Model settings
// panel. Pure so the pickers, the spawn path and the tests share one rule.

import type { ModelInfo, ModelRef } from "./types";

export function modelKey(m: ModelRef | { provider: string; id: string }): string {
  return `${m.provider}/${m.id}`;
}

export function sameModel(a?: ModelRef | null, b?: ModelRef | null): boolean {
  return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

// Models the pickers offer. The current pick always stays listed so a thread on
// a since-disabled model still shows what it runs on.
export function visibleModels(
  models: ModelInfo[],
  disabled: string[],
  current?: ModelRef | null,
): ModelInfo[] {
  if (disabled.length === 0) return models;
  const off = new Set(disabled);
  return models.filter((m) => !off.has(modelKey(m)) || sameModel(m, current));
}

// The model a new thread starts on: the user's preferred model while it is
// still available, else Pi's last pick. An unloaded model list trusts the pref.
export function resolveDefaultModel(
  preferred: ModelRef | null,
  models: ModelInfo[],
  piDefault: ModelRef | null,
): ModelRef | null {
  if (preferred && (models.length === 0 || models.some((m) => sameModel(m, preferred)))) {
    return preferred;
  }
  return piDefault;
}

// Flip a set of models on or off, returning the new disabled list.
export function setModelsEnabled(
  disabled: string[],
  keys: string[],
  enabled: boolean,
): string[] {
  const next = new Set(disabled);
  for (const k of keys) {
    if (enabled) next.delete(k);
    else next.add(k);
  }
  return [...next];
}
