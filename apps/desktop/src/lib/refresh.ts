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

  // Statuses and models are independent IPC calls; fetch them in parallel.
  await Promise.all([
    providerStatuses(providers.map((p) => p.id)).then(store.setProviderAuth),
    // list_models requires an active session and the panel must work without
    // one (first-key setup), so that case is swallowed. Real failures (sidecar
    // timeout or crash after a respawn) propagate to the caller; the error
    // string is ours, from commands.rs.
    listModels()
      .then(store.setModels)
      .catch((e) => {
        if (!String(e).includes("no active session")) throw e;
      }),
  ]);
}
