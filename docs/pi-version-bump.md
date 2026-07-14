# Pi version bump checklist

Pi (`@earendil-works/pi-coding-agent`) is pinned to an exact version; its SDK/RPC
surface is still evolving, so every bump is deliberate. Currently pinned:
**0.80.7** (`packages/sidecar/pi-src/package.json`).

On every bump:

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
