# Plan: Providers settings panel, wired (Hermes list + Zed detail)

Status: implemented (HOY-173, HOY-174, HOY-175; commits c0c4518, f6cc289, fba3ab4)

## Context

The global settings modal commit (`f6af4dc`) replaced the wired M2 `SettingsPage` with a
Hermes-style `SettingsModal` whose Providers panel is pure mock: `MOCK_PROVIDERS`, no IPC.
Nothing in the renderer calls `saveProviderKey` / `removeProviderKey` / `providerStatuses`
anymore, which breaks the MVP definition of done (spec section 8: "open settings and enter an
API key"). The backend is fully ready: `save_provider_key`, `remove_provider_key`,
`provider_statuses`, `supported_providers`, `list_models` are registered in
`src-tauri/src/lib.rs` and key save/remove respawns the active sidecar.

Target UX (decided):

- Hermes-style list: a "Connect an account" mock OAuth section on top (Claude Pro/Max and
  ChatGPT rows, disabled, "Coming soon" badge), then API-key providers with configured ones
  pinned on top, a featured set of 8 (anthropic, openai, openrouter, google, xai, deepseek,
  mistral, groq), and a collapsible "Show all" revealing the remaining ~19.
- Zed-style expanded detail per provider (accordion row): short description, a step list with
  a link to the provider's key console (opens in the system browser), a password input with a
  provider-specific placeholder, Enter or Save to submit, a hint line "You can also set
  <ENV_VAR> in the environment and restart Hoy.", a Connected badge showing the source
  (saved key / env var / login), and Remove only when `ProviderAuth.removable`.
- API-key providers only; OAuth rows are non-functional mocks.

## Verified facts

- `provider_statuses` / `supported_providers` are sync and sessionless
  (`src-tauri/src/commands.rs:89-124`). `list_models` errors with no active session, so model
  refresh after a key save must be best-effort.
- `App.tsx` bootstrap (lines 89-115) returns early when there is no active session, so the
  store's `supportedProviders` / `providerAuth` / `models` can be empty when the modal opens.
  The panel must self-bootstrap.
- `ProviderDef.env` exists in Rust (`pi_config.rs:85-114`) but `ProviderInfo` only exposes
  `{id, label}`. The env hint needs the env var name exposed. CLAUDE.md requires Rust/TS
  contract changes to land together.
- `src/components/ui/collapsible.tsx` exists. `@tauri-apps/plugin-opener` is installed with
  the `opener:default` capability (no usage in `src` yet); use its `openUrl` for console links.
- auth.json `api_key` entries beat env vars in Pi's resolution, so saving a key over an
  env-configured provider is valid; the badge flips to "saved key" after refresh.
- `set_api_key_at` replaces the whole auth entry (`pi_config.rs:211-218`), so saving a key
  over an oauth entry replaces the login. Warn inline in that case.
- Old wired flow reference: `git show e2733b9:src/components/SettingsPage.tsx`
  (busy/error/save/remove pattern, status wording).

## Steps

### 1. Backend: expose env var names

`src-tauri/src/pi_config.rs`

- Add `pub env: String` to `ProviderInfo` (lines ~116-121); populate in
  `supported_providers()` (lines ~125-133) from `ProviderDef.env`.
- Extend the `supported_providers_are_unique_and_nonempty` test (line ~386): `env` nonempty
  for all entries; google maps to `GEMINI_API_KEY`.

`src/lib/types.ts`

- Add `env: string` to the `ProviderInfo` interface (line ~123). Additive; `ipc.ts`,
  `store.ts`, `commands.rs` unchanged.

### 2. Static provider metadata

New file `src/components/settings/providerMeta.ts`:

- `FEATURED: string[]`: the 8 featured ids in display order.
- `PROVIDER_META: Record<string, ProviderMeta>` where
  `ProviderMeta = { description, consoleUrl, consoleLabel?, placeholder }`.
- `metaFor(id, label)` fallback for non-featured providers: description
  `"<label> models via API key."`, no console link (omit the step), placeholder
  `"Paste API key"`.
- Mock OAuth rows const: Claude Pro/Max (Anthropic subscription), ChatGPT (OpenAI
  subscription).

Featured values:

| id | consoleUrl | placeholder |
|---|---|---|
| anthropic | https://console.anthropic.com/settings/keys | sk-ant-xxxxxxxx |
| openai | https://platform.openai.com/api-keys | sk-proj-xxxxxxxx |
| openrouter | https://openrouter.ai/settings/keys | sk-or-v1-xxxxxxxx |
| google | https://aistudio.google.com/apikey | AIzaSyxxxxxxxx |
| xai | https://console.x.ai/team/default/api-keys | xai-xxxxxxxx |
| deepseek | https://platform.deepseek.com/api_keys | sk-xxxxxxxx |
| mistral | https://console.mistral.ai/api-keys | Paste API key |
| groq | https://console.groq.com/keys | gsk_xxxxxxxx |

### 3. Shared refresh helper

New file `src/lib/refresh.ts` exporting `refreshProviderData()`:

- Fetch `supportedProviders()` if the store list is empty, then `providerStatuses(ids)` and
  `setProviderAuth`.
- Best-effort `listModels()` in try/catch, `setModels` on success; swallow the
  "no active session" error.

`src/App.tsx`: replace the body of `refreshAuth` (lines ~79-87) with a call to this helper.

### 4. ProvidersPanel component

New file `src/components/settings/ProvidersPanel.tsx` (`panels.tsx` is ~800 lines; extract).
In `panels.tsx`: add `export` to the shared `PanelHeader` and `Section` primitives, delete
`MOCK_PROVIDERS` and the mock `ProvidersPanel` (lines ~486-559), import the new component;
the `case "providers"` switch arm stays.

Structure:

- **ProvidersPanel**: store selectors for `supportedProviders` / `providerAuth`; `useEffect`
  on mount calls `refreshProviderData()` (cheap, picks up env changes). Local state:
  `expandedId: string | null`, `showAll: boolean`. Partition providers: configured
  (auth.configured), then FEATURED minus configured, then the rest (alphabetical) behind the
  Show all `Collapsible`. One bordered list (`divide-y divide-border rounded-lg border`)
  with a subtle separator or group label between configured and the rest.
- **ConnectAccountSection** (mock): `Section` titled "Connect an account" with the two static
  rows, disabled Connect button, `Badge` "Coming soon", muted styling, no handlers.
- **ProviderRow** (owns its form state): props `{info, auth, expanded, onToggle, onChanged}`.
  - Collapsed: chevron, label, status badge when configured: env source renders
    "Connected, env var"; oauth kind renders "Connected, login"; otherwise
    "Connected, saved key". Reuse the emerald-dot pattern from the current mock
    (`panels.tsx` line ~536).
  - Expanded: description; step list (step 1 links to the console via
    `openUrl(meta.consoleUrl)`, omitted when absent; step 2 "Paste it below and press
    Enter"); password `Input` with the meta placeholder, `autoComplete="off"`, Enter saves,
    Save button disabled while busy or when the key is empty after trim; env hint with
    `info.env` in a `font-mono` chip; error line (`text-destructive`) rendering `String(e)`;
    Remove button only when `auth?.removable`; one-line warning when
    `auth?.kind === "oauth"` that saving a key replaces the login.
  - Save flow: busy, `saveProviderKey(id, key.trim())`, clear input, `await onChanged()`,
    collapse; catch sets the error. Remove mirrors it with `removeProviderKey`.

### 5. Order

1. `pi_config.rs` plus cargo test
2. `types.ts`
3. `providerMeta.ts`
4. `refresh.ts` plus the `App.tsx` swap
5. `ProvidersPanel.tsx` plus `panels.tsx` cleanup

## Edge cases

- No active session: the panel self-fetches; `listModels` failure swallowed; save/remove
  still work (respawn skipped backend-side).
- Empty or whitespace key: Save disabled client-side; backend also rejects.
- Env-configured provider: no Remove, key save allowed (auth.json wins).
- OAuth entry from an external `pi login`: badge "Connected, login", no Remove, saving
  replaces it (warned inline).
- Shared env vars (the cloudflare pair, the opencode pair) are harmless; each row shows its
  own hint.

## Verification

1. `cd src-tauri && cargo test` (pi_config tests), then `bun run tauri:dev`.
2. Via the Tauri MCP bridge: `ipc_execute_command` for `supported_providers`; entries carry
   `env`.
3. Settings, Providers: OAuth mock section (2 disabled rows, Coming soon), 8 featured,
   Show all reveals the rest.
4. Expand Anthropic: description, console link opens the system browser, placeholder
   sk-ant-xxxxxxxx, hint ANTHROPIC_API_KEY. Save a dummy key: badge "Connected, saved key",
   provider pins to the top, Remove appears; `~/.hoy/agent/auth.json` gains the entry
   (mode 0600).
5. Remove: badge clears, the row returns to its slot, the auth.json entry is gone.
6. Launch with `GROQ_API_KEY=x`: Groq pinned with "Connected, env var" and no Remove;
   saving a key flips the badge to "saved key".
7. With an active session, save a key: the sidecar respawns and the model picker gains that
   provider's models.
