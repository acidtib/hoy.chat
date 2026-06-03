# Follow-ups

Deferred engineering work discovered during the build. Not part of any milestone's
acceptance criteria; track and action separately.

## Restrict `withGlobalTauri` to dev builds (security hardening, before release)

Status: open
Priority: before any release/distribution build
Introduced: commit 47e3a6c (Tauri MCP bridge)

### Context
`src-tauri/tauri.conf.json` sets `app.withGlobalTauri: true`. This exposes the full
Tauri IPC API on `window.__TAURI__` in the webview. It was enabled because the
dev-time MCP bridge (`tauri-plugin-mcp-bridge`) drives the webview by injecting JS
and reading the result back through `window.__TAURI__`; without the global, every
`webview_*` bridge operation (screenshot, JS eval, click) times out.

The bridge plugin itself is already gated to dev builds (`#[cfg(debug_assertions)]`
in `src-tauri/src/lib.rs`), so in release builds nothing uses `withGlobalTauri`. The
flag is therefore pure attack surface in release: it hands any renderer JS (an XSS,
a compromised dependency) direct access to our commands, including `save_provider_key`.

### Why it's low risk today, not zero
The app loads only local bundled content (no remote URLs), and API keys live in
Rust/keychain and are never returned to the renderer, so a renderer with IPC access
cannot read a stored key. The exposure still violates least-privilege and should not
ship.

### Options (pick during M2 or release prep)
1. Keep `withGlobalTauri: false` in the base config and enable it only for dev by
   passing a config overlay to the dev command, e.g.
   `tauri dev --config src-tauri/tauri.dev.conf.json` where the overlay sets
   `app.withGlobalTauri: true`. Verify Tauri v2 merges `--config` as expected.
2. Check whether the bridge can use `window.__TAURI_INTERNALS__` (always present)
   instead of `window.__TAURI__`; if so, drop `withGlobalTauri` entirely. File
   upstream if it only supports the global.
3. At minimum, assert in release that the bridge is absent and `withGlobalTauri` is
   off (or document an explicit justification).

### Acceptance
Release builds have `withGlobalTauri` disabled (or a written justification), and the
dev MCP bridge still drives the webview.

### References
- `src-tauri/tauri.conf.json` (`app.withGlobalTauri`)
- `src-tauri/src/lib.rs` (`cfg(debug_assertions)` bridge registration)
- `src-tauri/capabilities/default.json` (`mcp-bridge:default`)
