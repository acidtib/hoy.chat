# Contributing to hoy.chat

Thanks for your interest. This is early, experimental software; expect the internals
to move. The notes below are the conventions the project holds itself to.

## Getting set up

See the [README](README.md) for requirements and the build-from-source steps. In
short, from the repo root:

```
bun install
bash packages/sidecar/build.sh
bun run tauri:dev            # runs in the isolated hoyd dev namespace
```

Before opening a pull request, make sure these pass:

```
bun run check     # tsc + cargo check + clippy + rustfmt
bun run lint      # oxlint + clippy
bun run test      # frontend tests
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## Architecture guardrails

A few decisions are fixed; please do not relitigate them in a PR:

- The stack is Tauri v2 (Rust core) + React/TypeScript/Vite + Bun. No Electron, no
  framework swaps.
- Pi runs as a separate spawned process over its JSONL-over-stdio RPC. Do not embed
  Pi in-process or reimplement its agent loop in Rust or TypeScript.
- The Vercel AI SDK is not used. UI blocks (AI Elements) are presentational
  components driven by our own state, never bound to `useChat`.
- Token streaming uses a Tauri `Channel`, never `emit`/`listen`.

## Working conventions

- **Rebuild the sidecar when `packages/sidecar/pi-src` changes** (`bash
  packages/sidecar/build.sh`) before testing. A stale binary silently runs old code.
- **Keep the frontend and backend contract in sync.** The `AgentEvent` union and
  command signatures are shared between Rust (`apps/desktop/src-tauri/src/events.rs`,
  `commands.rs`) and TypeScript (`apps/desktop/src/lib/types.ts`). Change both together.
- **Pi is pinned to an exact version.** Its RPC surface is still evolving; bump it
  deliberately and re-verify the command and event shapes.
- Typed `invoke` wrappers live in `apps/desktop/src/lib/ipc.ts`; do not scatter
  stringly-typed `invoke` calls through components.
- Rust: keep sidecar/process logic in `sidecar.rs` + `reader.rs`, `#[tauri::command]`
  functions in `commands.rs`, and Pi config/credential handling in `pi_config.rs`.
  Prefer `Result` returns and surface errors to the frontend as structured events.

## Style

- No emojis anywhere: not in code, comments, docs, or commit messages.
- No em-dashes. Use a comma, a semicolon, or rewrite the sentence.
- Code comments state facts, decisions, and the why, not a narration of what the code
  does.

## Commits and pull requests

- Prefix commits with the tracking id when there is one: `HOY-NNN: short summary`.
- Plain commit messages. No `Co-Authored-By` trailers.
- Keep each PR focused. Describe what changed and how you verified it.
