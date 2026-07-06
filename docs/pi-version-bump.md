# Pi version bump checklist

Pi (`@earendil-works/pi-coding-agent`) is pinned to an exact version; its SDK/RPC
surface is still evolving, so every bump is deliberate. Currently pinned:
**0.80.3** (`packages/sidecar/pi-src/package.json`).

On every bump:

- Re-verify the tool `promptGuidelines` in `hoy-system-prompt.ts` against Pi
  source (the edit guidelines are load-bearing).
- Repoint the docs-block GitHub tag.
- Re-check the provider list and env-var mapping in `pi_config.rs`.
- Confirm exact RPC command names and fields against the installed version before
  relying on them.
- Re-run the prompt assembly tests (`bun run test`).
- Update the pinned version surfaced in the About panel (`PI_VERSION` in
  `apps/desktop/src/components/settings/panels.tsx`).

RPC surface coverage per version is tracked in `docs/pi-rpc-coverage.md`.
