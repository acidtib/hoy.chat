# Pi sidecar packaging (M0)

How we turn Pi's Node CLI into a self-contained binary Tauri can spawn. This
directory holds the build inputs and a throwaway harness proving the round-trip.
Build outputs are gitignored and regenerated with `build.sh`.

## Result

M0 is proven on `x86_64-unknown-linux-gnu`. A Bun-compiled binary plus a small
asset payload answers `get_state` over JSONL when spawned from Rust.

## Recipe

```
packages/sidecar/build.sh   # builds hoy-pi-<host-triple> + pi-payload/
```

`build.sh` does three things:

1. Installs the pinned Pi (`@earendil-works/pi-coding-agent`, version in
   `pi-src/package.json`) into `pi-src/node_modules`.
2. `bun build --compile` of Pi's **bun entry** (`dist/bun/cli.js`, which restores
   sandbox env and registers bedrock) into `hoy-pi-<target-triple>`, named for
   Tauri's `externalBin` convention.
3. Assembles `pi-payload/` with the assets Pi's bun binary expects.

## Why a separate asset payload

Pi's `config.js` detects a Bun binary (`import.meta.url` contains `$bunfs`) and
resolves its assets next to the executable, **not** from inside the bundle:
`package.json` (read at startup for name/version), `theme/`, `export-html/`,
`assets/`. A compiled binary with no assets beside it crashes at startup
(`ENOENT ... package.json`, then `theme/dark.json`).

Pi provides `PI_PACKAGE_DIR` to override the asset directory (its comment cites
Nix/Guix store paths). We point it at `pi-payload/`, which decouples the assets
from the executable's location. The Tauri sidecar will set `PI_PACKAGE_DIR` to
the resolved resource dir at spawn time and ship `pi-payload/` as a bundle
resource alongside the binary.

The native addons in Pi's tree (`@mariozechner/clipboard-*`, `pi-tui` native
modifiers) and the `photon-node` WASM are lazily loaded by the TUI/image paths
and are never reached in `--mode rpc`, so they do not block the sidecar.

## Spawn contract used by the harness

```
hoy-pi-<triple> --mode rpc --no-session --offline --no-context-files
  env: PI_PACKAGE_DIR=<abs path to pi-payload>
  stdin:  {"type":"get_state","id":"..."}\n
  stdout: {"type":"response","command":"get_state","success":true,"data":{...}}\n
```

JSONL framing is LF-only; strip a trailing `\r`; never split on U+2028/U+2029
(they are valid inside JSON strings). The harness mirrors Pi's own `jsonl.js`.

## Version pin

Pinned in `pi-src/package.json` and `pi-src/package-lock.json`. Pi's RPC surface
is still evolving; bump deliberately and re-verify the contract. The RPC command
and event shapes were confirmed against the installed version's
`dist/modes/rpc/rpc-types.d.ts` and the published RPC doc.

## Fallbacks (not needed; recorded for the record)

If a future Pi release breaks `bun build --compile`: ship Node alongside and
invoke `node dist/cli.js`, or bundle Pi's source with a minimal Node runtime.
Neither was required at 0.80.6.

## Files

- `pi-src/` — pinned install workspace (`package.json` + lockfile tracked,
  `node_modules/` gitignored)
- `build.sh` — produces `hoy-pi-<triple>` + `pi-payload/`
- `hoy-pi-<triple>`, `pi-payload/` — build artifacts, gitignored
