# hoy.chat

A desktop app for coding agents. It runs [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
on your machine, gives it a real UI instead of a terminal, and keeps your API
keys on your own disk.

> Beta. Pre-1.0, so expect bugs and breaking changes. Bring your own model API
> key.

## Install

Signed builds ship for macOS (Apple Silicon and Intel), Windows, and Linux on
every release. You bring your own model API key, the app writes it to disk on your
own machine and never sends it anywhere but the model provider you pick.

- **Any platform:** [hoy.chat](https://hoy.chat) offers the right build for your
  OS, or grab an installer straight from the
  [latest release](https://github.com/acidtib/hoy.chat/releases/latest)
  (`.dmg`, `.msi` / `.exe`, `.AppImage`, `.deb`, `.rpm`).
- **Arch Linux:** install from our own signed pacman repo, not the AUR. One-time
  setup adds the key and repo, then it upgrades like any package. See
  [packaging/pacman-repo/README.md](packaging/pacman-repo/README.md) for the
  copy-paste steps.

Hit a bug? That is expected in beta, please
[open an issue](https://github.com/acidtib/hoy.chat/issues/new/choose). To build
from source instead, see below.

## Repository layout

Bun-workspaces monorepo:

```
apps/
  desktop/          Hoy Desktop: Tauri v2 shell + React/TypeScript webview
    src/            renderer (React)
    src-tauri/      Rust core (spawns and talks to Pi)
  site/             marketing site (Next.js; run from root with bun run site:dev)
packages/
  sidecar/          Pi SDK entry, compiled to a self-contained binary
    pi-src/         pinned Pi install + our branded entry (hoy-sidecar.ts)
    build.sh        produces pi-<triple> + pi-payload/
scripts/            release + local-install helpers
docs/               design notes and plans
```

## Architecture

Three layers, the same shape as other agent desktop apps (renderer -> native core ->
spawned agent process):

1. **Renderer** (React/TypeScript, `apps/desktop/src`). Presents the transcript,
   composer, tool calls, and session sidebar. Talks to the core over Tauri IPC; token
   deltas stream over a Tauri Channel.
2. **Native core** (Rust/Tauri, `apps/desktop/src-tauri`). Owns the spawned Pi
   processes (one per session), speaks Pi's JSONL-over-stdio RPC, and maps Pi events to
   a typed `AgentEvent` stream for the renderer. Credentials are written to Pi's
   `auth.json` and never flow back to the renderer.
3. **Agent** (Pi, `packages/sidecar`). Pi runs as a separate spawned process, not
   embedded. We ship our own thin SDK entry that runs Pi's RPC mode with Hoy branding
   and a resource loader; we do not reimplement Pi's agent loop.

## Build from source

Requirements: [Bun](https://bun.sh), a [Rust](https://rustup.rs) toolchain, Node (for
the sidecar's `npm ci`), and the Tauri Linux system dependencies
(`libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`) on Linux.

```
bun install            # wire the workspace
bun run sidecar:build  # build the Pi sidecar binary + payload
bun run tauri:dev      # launch the app in development
```

Other tasks, all from the repo root:

```
bun run check      # tsc + cargo check + clippy + rustfmt
bun run lint       # oxlint + clippy
bun run test       # frontend tests (bun test)
bun run site:dev   # run the marketing site (also site:build, site:start, site:lint)
```

`bun run tauri:dev` is the only supported dev entry; it runs in an isolated `hoyd`
namespace (separate app identifier and agent dir) so you can safely run Hoy on Hoy.

## License

Hoy is released under the MIT License; see [LICENSE](LICENSE). It bundles the Pi
coding agent (`@earendil-works/pi-coding-agent`), which is also MIT licensed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
