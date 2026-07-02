# HOY-210: MCP support

Spike. Ticket asks: use
[`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) as the
**inspiration** for our MCP implementation, and figure out the **global** MCP
settings page and the **per-project** one.

Framing (corrected after review): Pi does not ship MCP; it expects users to add
an extension like `pi-mcp-adapter`. We do NOT want to bundle and ship that
third-party extension. We want to **learn from it and build MCP support natively
into Hoy** as our own in-process extension. That is also the better architectural
fit: CLAUDE.md already says we own `hoy-sidecar.ts` precisely to "inject a custom
resource loader / in-process tools," and MCP is exactly such an in-process tool.

## Verdict: implement MCP as our own in-process Pi extension in the sidecar (`createHoyMcp`), proxy-tool first, driven by branded config + a React settings UI

Add a `createHoyMcp(...)` extension factory to `hoy-sidecar.ts`'s
`extensionFactories`, right next to `createHoyPermissions`. It uses the official
`@modelcontextprotocol/sdk` (a sidecar dependency, bundled by `bun --compile`) to
connect MCP servers and registers a single `mcp` proxy tool with Pi via the
extension API. Config lives in our branded dirs; the UI is ours (React), not
Pi's TUI. Steal the adapter's *design ideas* (below); write none of its code.

Owning it (vs. bundling the adapter) buys three things that matter here:

- **Full branding control:** project config can be `.hoy/mcp.json` (the adapter
  hardcodes `.pi/mcp.json`).
- **No TUI baggage:** the adapter's `/mcp` panels render through
  `@earendil-works/pi-tui` and would be auto-cancelled in our RPC world (HOY-186).
  Our config is file + React UI, so there is nothing to fight.
- **Clean security integration:** consent flows through our permission gate,
  extension-UI protocol, and Pi's `project_trust`, not a vendored consent model.

## Pi has no native MCP (evidence)

- Grepping installed 0.80.3 `dist` for
  `modelcontextprotocol|mcpServers|mcp.json|StdioClientTransport` returns nothing
  (only a coincidental substring in the `highlight.min.js` vendor file).
- Pi's core tool set is exactly `read, bash, edit, write, grep, find, ls`
  (`dist/core/tools/*.js`). No `mcp` tool. `rpc-types.d.ts` has no `mcp`.

MCP can only enter a Pi session as a tool registered by an extension. So Hoy's
MCP support IS "write the extension," which is what this ticket becomes.

## We already pre-wired the seam in three places (currently dangling)

1. `hoy-sidecar.ts:28` enables a tool named `"mcp"` in `HOY_TOOLS`.
2. `hoy-system-prompt.ts:103` advertises it: "... and **mcp (Linear, docs,
   etc.)**."
3. `hoy-permissions.ts:36` already has a policy branch for it (`toolName ===
   "mcp"` is allowed in plan mode; unknown/custom tools otherwise "ask").

Nothing registers an `mcp` tool today, so this is dead pre-wiring, and the plan
prompt currently advertises a tool the agent does not have (a latent honesty bug
to fix as part of this work). Our `createHoyMcp` closes all three seams by
registering a tool literally named `mcp`.

## Where our MCP lives, and the API we build against

In-process extension factory, same shape as `createHoyPermissions`:

```ts
// hoy-sidecar.ts
extensionFactories: [createHoyPermissions(initialMode), createHoyMcp(mcpConfig)],
```

`createHoyMcp` returns `function hoyMcp(pi: ExtensionAPI) { ... }` and uses the
verified 0.80.3 extension surface:

- `pi.registerTool(tool: ToolDefinition)` — the proxy `mcp` tool.
  `ToolDefinition` (`dist/core/extensions/types.d.ts:335`) gives us everything:
  `name`, `label`, `description`, `promptSnippet` (its own "Available tools" line,
  so we can drop the hand-written mention in the prompt), `promptGuidelines`,
  `parameters` (TypeBox schema), and
  `execute(toolCallId, params, signal, onUpdate, ctx)` — `signal` for abort,
  `onUpdate` to stream progress, `ctx` for UI. That is a clean home for
  `mcp({ search | describe | tool, args })`.
- `pi.on("session_start" / "session_shutdown")` — connect eager servers / tear
  down clients and child processes.
- `pi.on("project_trust", ...)` — Pi already has a project-trust mechanism
  (`dist/core/project-trust.js`; `ProjectTrustEvent` in the extension types). This
  is the correct gate for auto-loading a repo's `.hoy/mcp.json` (see Security).

**MCP client:** the official `@modelcontextprotocol/sdk` (`^1.25.x`) as a sidecar
dep in `packages/sidecar/pi-src/package.json`, imported by `hoy-mcp.ts`, bundled
into the compiled binary by `bun --compile` (HOY-228 proved arbitrary deps bundle
in). This is *simpler* than the adapter's disk-install-with-node_modules route:
in-process, no provisioning step, one build. stdio transport spawns servers as
child processes of the sidecar; streamable-HTTP/SSE for remote.

One MCP client set per sidecar = per session (matches the adapter, which does not
share servers across sessions). Cross-session sharing is a future optimization,
not v1; nothing here blocks it.

## Design ideas worth stealing from the adapter (not its code)

- **Single proxy tool for token efficiency.** Registering every server's tools up
  front can cost 10k+ tokens each; one `mcp` proxy tool is ~200. The model
  discovers via `mcp({search})`/`mcp({describe})` and calls via
  `mcp({tool, args})`. This is the v1 shape and it matches our context discipline
  and the single pre-wired `mcp` name.
- **Lazy lifecycle + metadata cache.** Don't connect a server until its tool is
  first called; cache tool metadata so search/describe work offline. Also support
  `eager`/`keep-alive` and `idleTimeout` later.
- **Config precedence and `${ENV}` interpolation** for secrets.
- **Transports:** stdio (`command`/`args`/`env`/`cwd`) and HTTP; OAuth later.
- **A consent model** per server before first connect.
- **Defer:** direct-tool promotion, OAuth, MCP-UI windows, elicitation, sampling.
  All are real features in the adapter; none are v1.

## Config location and branding (now fully ours)

Because it is our extension, we choose the paths. Recommended:

- **Global:** `~/.hoy/agent/mcp.json` (dev `~/.hoyd/agent/mcp.json`). Rust already
  exports `PI_CODING_AGENT_DIR` here; `hoy-mcp.ts` reads it the same way
  `hoy-sidecar.ts` already does.
- **Per-project:** `<project>/.hoy/mcp.json`, consistent with the branded project
  config dir (HOY-222). Optionally also read a generic `.mcp.json` for
  cross-tool interop, but write our own to `.hoy/`.
- **Format:** the standard `{ "mcpServers": { name: { command|url, args, env,
  lifecycle, ... } } }`, so a server declared for Cursor/Claude Code pastes in.

Precedence (high to low): project `.hoy/mcp.json` > global `~/.hoy/agent/mcp.json`.
Merge, project wins on name collision; mark scope in the UI.

## Settings UI (the ticket's explicit ask)

Two thin, Rust-owned file editors over `mcpServers`, following the
`pi_config.rs` / auth.json pattern (atomic write, preserve unknown keys, never
brick the file on malformed JSON):

- New `mcp_config.rs` (or extend `pi_config.rs`): Tauri commands to read/write the
  global and active-project `mcp.json`, plus `lib/ipc.ts` wrappers and
  `lib/types.ts` shapes mirroring the server schema.
- Settings > MCP React page: a **Global** section (`~/.hoy/agent/mcp.json`) and a
  **Per-project** section for the active project (keyed by cwd, HOY-196), visually
  separated and scope-labelled. Add/edit/remove/enable; fields: name, transport
  (stdio `command/args/env/cwd` | http `url/headers`), `lifecycle`, `idleTimeout`,
  and an explicit consent state. No direct-tools in v1.
- **Propagation:** after a write, **respawn the sidecar** (reuse the post-auth
  respawn path in `sidecar.rs`, which already skips mid-turn sessions).
  `createHoyMcp` reads config at construction; lazy lifecycle means respawn
  connects nothing eagerly, so it is cheap.

## Security posture (must be explicit)

- Adding an MCP server = **arbitrary subprocess execution** (stdio) and/or network
  egress. Treat it like enabling `bash`. The global settings page must make adding
  a server an explicit, consented action.
- **The proxy tool blunts our name-based gate.** `hoy-permissions.ts` decides by
  tool *name*; every MCP call is the single name `mcp`, so the gate can allow/ask
  only once for "all MCP," not per server/tool. Fine-grained consent (which
  server, which tool) must live **inside `createHoyMcp`** (a per-server/per-tool
  consent layer via `ctx.ui.select`, mirroring the adapter's consent-manager), and
  the approval card should name the target server+tool. Design the consent layer
  in v1 even if the policy is coarse at first.
- **Untrusted repo `.hoy/mcp.json` is the sharp edge.** Cloning a repo must not
  silently run its declared servers. Gate project-scope servers behind Pi's
  `project_trust` handler (already available) + explicit user consent before any
  connect. Lazy lifecycle helps (nothing runs until `mcp()` is called), but the
  decision belongs at load/consent, not first call.
- Secrets via `${ENV}` interpolation or a Rust-owned store, never plaintext in a
  committed `.hoy/mcp.json`.

## Validated by the HOY-232 spike (2026-07-02)

A throwaway spike branch built a minimal `createHoyMcp` (proxy `mcp` tool, lazy
stdio connect, per-server consent, shutdown teardown) against the real
`@modelcontextprotocol/sdk` and proved the sidecar seam three ways: `bun test`
contract vs. a real stdio MCP server, the real entry over RPC, and the
`bun --compile` binary over RPC (`/mcp_selftest`: search returned the server's
tools, call returned its result). Full suite stayed green (33/33). Confirmed:

- **Registered-tool activation.** An extension-registered `mcp` tool is active
  and callable; no separate allowlist step needed beyond `HOY_TOOLS` already
  listing it. v1 stays proxy-only for the direct-tools reason above, not because
  registration is uncertain.
- **`ToolDefinition` shape** is exactly as documented;
  `execute(id, params, signal, onUpdate, ctx)` with `ctx: ExtensionContext`.
- **Consent works.** `ExtensionContext.ui.select` is real and usable inside
  `execute` (the load-bearing security unknown, since the proxy tool defeats the
  name-based gate). Deny blocks the connect; consent caches per session.
- **Bundling works.** `@modelcontextprotocol/sdk` + `typebox` + `zod` compile
  into the single `--compile` binary and run; no provisioning step.

Two refinements to the checklist below came out of the spike:

- **Pin `typebox` as an explicit sidecar dep at `1.1.38`.** Pi imports `Type`
  from `"typebox"` (a renamed fork, not `@sinclair/typebox`) and does NOT
  re-export it; its copy is nested under Pi's own `node_modules`, so our entry
  cannot resolve it without declaring the dep. Step 1 adds `typebox` alongside
  the MCP SDK, both pinned. (Matching Pi's exact version keeps the `TSchema`
  types identical.)
- **Gate project-scope servers with `ctx.isProjectTrusted()`**, which exists
  synchronously on the `ExtensionContext` passed to `execute` (cleaner than
  subscribing to the `project_trust` event).

## Still to verify during implementation (not blockers)

- Confirm `promptSnippet`/`promptGuidelines` on the registered tool render into
  our overridden system prompt (we use `systemPromptOverride`); if not, keep the
  prompt mention but make it conditional on MCP being configured. (The spike did
  not exercise the prompt path; the tool worked without it.)
- Re-run the real-server smoke test against a production MCP server (filesystem
  or Linear), not just the spike's local test server, before claiming support.

## Phasing

1. **v1:** `createHoyMcp` in-process extension; `@modelcontextprotocol/sdk` dep;
   proxy `mcp` tool; stdio + HTTP; lazy lifecycle + metadata cache; global
   `~/.hoy/agent/mcp.json` + project `.hoy/mcp.json`; Rust read/write commands;
   Settings > MCP React UI; per-server consent + `project_trust` gating; respawn
   on change; fix the dangling prompt/tool seam. Live-verify a real server (e.g. a
   filesystem or Linear MCP) round-trips over RPC.
2. **v2:** direct-tool promotion, OAuth flows, elicitation rendering, MCP-UI,
   sampling, cross-session server sharing.

## Implementation checklist (for the follow-up ticket)

1. Add `@modelcontextprotocol/sdk` (pinned) to `packages/sidecar/pi-src/package.json`.
2. `hoy-mcp.ts`: `createHoyMcp(config)` extension factory — config load, MCP
   client management (stdio/http), lazy connect + metadata cache, proxy `mcp`
   tool (`search`/`describe`/`tool`), per-server consent, `session_shutdown`
   teardown. Add unit tests like `hoy-permissions.test.ts`.
3. Wire it into `extensionFactories` in `hoy-sidecar.ts`; thread config in from
   Rust (env or a file path), mirroring `HOY_PERMISSION_MODE`.
4. `mcp_config.rs`: atomic read/write of global + project `mcp.json`; Tauri
   commands + `lib/ipc.ts` + `lib/types.ts`.
5. Settings > MCP React page (global + per-project, add/edit/remove, consent).
6. Respawn sidecar on config change (reuse the auth.json respawn path).
7. Make `mcp` in `HOY_TOOLS`/the prompt real and conditional on configuration;
   stop advertising it when unconfigured.
8. `packages/sidecar/build.sh` rebuild + live-verify a real MCP server via
   `mcp({tool,...})` through the compiled binary over RPC; global + project both
   honored; consent + project_trust enforced. Commit `HOY-210:` with evidence.

## Alternatives considered

- **Bundle `pi-mcp-adapter` as-is** (my first draft): rejected per direction. It
  is a fine reference and a viable fallback, but it is third-party code with TUI
  panels we can't drive, a vendored consent model, and `.pi/` project-config
  branding. Building our own is a bit more code for a much better fit and full
  control. Keep the adapter bookmarked as the reference implementation.
- **MCP client in Rust** (e.g. `rmcp`): rejected. Pi tools must be registered
  through the TS extension API in the sidecar; putting the client in Rust means a
  second cross-process hop for every tool call and a split implementation. Config
  and UI stay in Rust; the MCP client belongs in the sidecar with the tool it
  backs.
