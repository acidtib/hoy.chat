# Pi version bump checklist

Pi (`@earendil-works/pi-coding-agent`) is pinned to an exact version; its SDK/RPC
surface is still evolving, so every bump is deliberate. Currently pinned:
**0.84.0** (`packages/sidecar/pi-src/package.json`).

On every bump:

- Update `@earendil-works/pi-coding-agent` in `dependencies` **and**
  `@earendil-works/pi-agent-core`, `pi-ai`, `pi-tui` in `overrides` in
  `packages/sidecar/pi-src/package.json` to the same version — those three
  ship as caret ranges and drift ahead of `pi-coding-agent` on their own patch
  releases if left unpinned. Also check whether `pi-coding-agent`'s own
  `package.json` bumped its bundled `typebox` version and match it.
  Then `bun install` in `pi-src/` to refresh `bun.lock`, and confirm via
  `find node_modules -path "*@earendil-works/pi-ai/package.json"` (etc.) that
  there's exactly one deduped copy at the new version.
- Re-verify the tool `promptGuidelines` in `hoy-system-prompt.ts` against Pi
  source (the edit guidelines are load-bearing).
- Compare custom-prompt assembly, especially Pi-appended context such as the
  working directory.
- Repoint the docs-block GitHub tag.
- Re-check the OAuth provider registry and the API-key provider/env-var mapping
  in `pi_config.rs`.
- Compare RPC command, response, event, and extension UI declarations against
  the installed version.
- Confirm the SDK exports imported by `hoy-sidecar.ts` and extension factories.
- **Actually run an OAuth login for at least one provider against the freshly
  compiled binary**, not just `bun test`/`check:ts`. `hoy-sidecar.ts` calls
  `registerBunOAuthFlows()` from `@earendil-works/pi-ai/bun-oauth` at startup
  (before any other code path) because pi-ai loads each provider's OAuth flow
  module through a deliberately-unbundleable variable `import()` specifier
  (`auth/oauth/load.js`) — inside a `bun --compile` binary that fails with
  `Cannot find module './<provider>.js' from '/$bunfs/...'` unless the bundled
  loaders are registered first, exactly like Pi's own `dist/bun/cli.js` does.
  This is silent in `tsc`/`bun test` (which don't run inside the compiled
  binary) and breaks not just the login flow but any RPC session that resolves
  or refreshes an existing OAuth credential. If a future Pi version restructures
  `bun-oauth.js`/`registerBunOAuthFlows`, re-verify this call still resolves.
- Re-run the isolated sidecar tests
  (`cd packages/sidecar/pi-src && bun test`).
- Rebuild with `bun run sidecar:build` and assert the generated payload version,
  `piConfig.configDir=".hoy"`, and `piConfig.name="hoy"`.
- Update the pinned version surfaced in the About panel (`PI_VERSION` in
  `apps/desktop/src/components/settings/panels.tsx`).

Pi 0.80.7 renamed the custom OpenAI Responses session-affinity option. User-owned
`~/.hoy/models.json` entries using `compat.sendSessionIdHeader: false` must use
`compat.sessionAffinityFormat: "openai-nosession"` instead. Hoy does not rewrite
user-maintained custom model configuration.

RPC surface coverage per version is tracked in `docs/pi-rpc-coverage.md`.
