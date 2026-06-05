// Shared provider/auth/model refresh used by App bootstrap and the Providers
// settings panel. The panel can open before any session exists (App's bootstrap
// returns early without one), so this self-fetches the provider list when the
// store is empty.

import { listModels, providerStatuses, supportedProviders } from "./ipc";
import { useSessionStore } from "@/state/store";

export async function refreshProviderData(): Promise<void> {
  const store = useSessionStore.getState();

  let providers = store.supportedProviders;
  if (providers.length === 0) {
    providers = await supportedProviders();
    store.setSupportedProviders(providers);
  }

  store.setProviderAuth(await providerStatuses(providers.map((p) => p.id)));

  // Best-effort: list_models requires an active session and the panel must work
  // without one (first-key setup), so a failure here is not surfaced.
  try {
    store.setModels(await listModels());
  } catch {
    // no active session; keep whatever models the store has
  }
}
