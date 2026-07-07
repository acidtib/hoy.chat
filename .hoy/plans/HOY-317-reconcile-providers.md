# HOY-317: Reconcile pi_config.rs PROVIDERS with Pi's built-in provider table

**Goal:** Add three providers Pi supports but Hoy's Rust table omits (`ant-ling`, `nvidia`, `zai-coding-cn`), update the stale `zai` label, and fix one incorrect env var (`moonshotai-cn`), bringing `pi_config.rs` into exact alignment with Pi 0.80.3's `core/provider-display-names.js` + `env-api-keys.js`.

**Architecture:** Data fix only. No new types, no IPC contract changes, no frontend work. The three new providers appear automatically in the settings picker (they flow through `supported_providers()` -> `commands.rs` -> `ipc.ts` -> `ProvidersPanel` with fallback meta). The fixed `moonshotai-cn` env var corrects the environment-based auth detection path for that provider.

**Tech Stack:** Rust (`pi_config.rs`), Pi source as reference (`env-api-keys.js`, `provider-display-names.js`), docs (`pi-rpc-coverage.md`).

## Approaches considered

Only one reasonable approach: read Pi's authoritative `env-api-keys.js` and `provider-display-names.js` and make `pi_config.rs` match. There is no judgment to exercise -- Pi defines the truth, Hoy mirrors it.

## Design rationale

Pi's `env-api-keys.js` is the single source of truth for per-provider env var names. Pi's `provider-display-names.js` is the single source of truth for display labels. `pi_config.rs` references both in a comment and must stay in lockstep. The three missing providers (`ant-ling`, `nvidia`, `zai-coding-cn`) simply never made it into Hoy's table; the `zai` label was just stale. The `moonshotai-cn` env var (`MOONSHOT_CN_API_KEY` vs Pi's `MOONSHOT_API_KEY`) is the only actual env-var error in the table -- Pi reuses `MOONSHOT_API_KEY` for both `moonshotai` and `moonshotai-cn`.

## Key changes

- `apps/desktop/src-tauri/src/pi_config.rs`: Add 3 providers, fix 1 label, fix 1 env var, update version comment
- `docs/pi-rpc-coverage.md`: Note the pre-existing gap is now closed

## Steps

1. **Update the version comment and add/fix providers in pi_config.rs**
   File: `apps/desktop/src-tauri/src/pi_config.rs`
   - Change the `0.78.0` comment reference to `0.80.3`
   - Add `ant-ling` entry: `id: "ant-ling", label: "Ant Ling", env: "ANT_LING_API_KEY"`
   - Add `nvidia` entry: `id: "nvidia", label: "NVIDIA NIM", env: "NVIDIA_API_KEY"`
   - Add `zai-coding-cn` entry: `id: "zai-coding-cn", label: "ZAI Coding Plan (China)", env: "ZAI_CODING_CN_API_KEY"`
   - Change `zai` label from `"ZAI"` to `"ZAI Coding Plan (Global)"`
   - Change `moonshotai-cn` env from `"MOONSHOT_CN_API_KEY"` to `"MOONSHOT_API_KEY"`
   Insert the three new entries in alphabetical order among the existing providers.
   Verify: `cargo test -p hoy-desktop pi_config` (all 12 tests pass, including `supported_providers_are_unique_and_nonempty` which will pick up the new providers)

2. **Update pi-rpc-coverage.md to close the gap note**
   File: `docs/pi-rpc-coverage.md`
   - Replace the parenthetical note at line 27-29 (about `ant-ling`, `nvidia`, `zai-coding-cn`, and `zai` label being a pre-existing gap) with a note that HOY-317 reconciled the table
   Verify: review the edited section reads correctly

3. **Live-verify with the running app**
   - `bun run tauri:dev`
   - Open Settings -> Providers, confirm `ant-ling`, `nvidia`, and `zai-coding-cn` appear in the provider list with correct labels
   - Confirm `zai` label shows "ZAI Coding Plan (Global)"
   - Enter a key for `moonshotai-cn`, save, restart, verify the key persists and `statuses` reports it as configured

## Test plan

- `cargo test -p hoy-desktop pi_config` -- all 12 existing tests pass; `supported_providers_are_unique_and_nonempty` verifies the new providers are present, unique, and have non-empty env vars
- The `env_var_for` test still passes (no new cases needed for the added providers, but `moonshotai-cn` now returns `MOONSHOT_API_KEY` instead of `MOONSHOT_CN_API_KEY` -- verify this implicitly through the existing test structure)
- Live smoke test: open providers panel, confirm all new providers appear

## Assumptions and risks

- **Assumption:** Pi does not expose these three providers as OAuth-only. `env-api-keys.js` lists env vars for all three, confirming they support API key auth.
- **Assumption:** Providers with Pi env var names that match the `UPPERCASED_ID_API_KEY` convention (`ant-ling`, `nvidia`, `zai-coding-cn`) will work with Hoy's existing `env_var_for` fallback even without entries. True, but adding them explicitly ensures the configured-via-environment status signal is accurate.
- **Risk (low):** Provider keys for `ant-ling`, `nvidia`, and `zai-coding-cn` have never been tested end-to-end in Hoy since they were absent from the picker. Adding them to the list makes them configurable but does not guarantee Pi's model discovery returns models for them on every user's account. This is fine: the picker shows all supported providers regardless of model availability.
- **Open question:** Should we add `PROVIDER_META` entries in `providerMeta.ts` for the three new providers? Not required -- `metaFor` has a fallback (`"${label} models via API key."` + `"Paste API key"` placeholder), so they display fine without explicit meta. Adding dedicated descriptions and placeholder formats is a follow-up polish task, not part of this reconciliation.

## Critical files

- `apps/desktop/src-tauri/src/pi_config.rs` -- the PROVIDERS table and comment
- `docs/pi-rpc-coverage.md` -- the gap note to update
- `packages/sidecar/pi-src/node_modules/@earendil-works/pi-coding-agent/dist/core/provider-display-names.js` -- Pi's authoritative display names
- `packages/sidecar/pi-src/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/env-api-keys.js` -- Pi's authoritative env var mapping
