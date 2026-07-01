# HOY-228: Disk extension / skill discovery from the branded agent dir

Spike (timeboxed). Question: can disk-based `.ts` extensions and skills be
discovered and loaded from the branded agent dir (`~/.hoy/agent`, dev
`~/.hoyd/agent`) by the **bun `--compile`d** sidecar binary, not `bun run`? The
runtime story for disk `.ts` extensions (loaded via `jiti`, schemas validated
via `typebox`) inside a compiled binary was unproven, and shipped broken at
zosma-cowork (#151 / #152).

## Verdict: PROVEN WORKING

Disk extensions (including the hard "extension with its own npm dependency"
case) and disk skills load correctly inside the compiled sidecar binary against
the branded `PI_CODING_AGENT_DIR`. No fix was required: Pi 0.80.2 already solves
the compiled-binary problem that broke zosma. Recommendation: **ship** the disk
discovery capability (it already works with zero code changes); the only open
work is install UX and a version-bump re-check note.

## Why it works in 0.80.2 (the zosma break is already fixed upstream)

Pi's extension loader (`dist/core/extensions/loader.js`) detects the compiled
binary and switches jiti's resolution strategy:

- `isBunBinary` = `import.meta.url` contains `$bunfs` / `~BUN` (`dist/config.js:16`).
- `createJiti` is imported from `jiti/static` (statically, so bun bundles it).
- The loader statically imports `typebox`, `typebox/compile`, `typebox/value`
  and the pi packages, then exposes them to extensions via jiti's
  `virtualModules` option **when `isBunBinary`** (with `tryNative: false` so jiti
  handles every import), falling back to filesystem `alias` in Node/dev
  (`loader.js:29-51`, `302-309`). The source comment is explicit: "These MUST be
  static so Bun bundles them into the compiled binary."
- An extension's **own** dependencies (e.g. `ms`) are not virtual modules; jiti
  still resolves those from the extension directory's `node_modules` on disk.

Disk auto-discovery itself needs **no opt-in**. `createAgentSessionServices`
builds a `DefaultResourceLoader` with the passed `agentDir` and calls `reload()`
(`dist/core/agent-session-services.js:60-66`). `reload()` -> package-manager
`resolve()` unconditionally scans user-scope resources at
`<agentDir>/{extensions,skills,prompts,themes}`
(`dist/core/package-manager.js:1875-1930`, `addAutoDiscoveredResources`; user
scope is added unconditionally, project scope is trust-gated). So the current
`hoy-sidecar.ts` already inherits disk discovery from the branded dir because it
threads `agentDir` (= `PI_CODING_AGENT_DIR`) through the factory.

Deps confirmed pinned in the Pi package: `jiti` 2.7.0, `typebox` 1.1.38.

## What was tried / reproduction

Environment: Pi `@earendil-works/pi-coding-agent` 0.80.2, bun 1.3.12, target
`bun-linux-x64`, host `x86_64-unknown-linux-gnu`.

### 1. Test agent dir

A throwaway agent dir with three disk resources:

- `extensions/hello.ts` — loose `.ts` file, imports `typebox` (the virtual-module
  case), registers a tool `hoy_hello` and a command `hoy-hello`.
- `extensions/with-deps/` — the hard case: `package.json` with
  `pi.extensions: ["./index.ts"]` and a real `ms@2.1.3` dependency installed into
  its own `node_modules`; `index.ts` imports `ms` (own node_modules) **and**
  `typebox` (virtual), registers tool `hoy_parse_duration`.
- `skills/greet/SKILL.md` — a markdown skill `hoy-greet` (skills need no jiti).

### 2. Compiled probe (decisive, shows loader errors directly)

A throwaway probe entry was compiled the same way `build.sh` compiles the
sidecar (`bun build --compile --target=bun-linux-x64`) and run with
`PI_CODING_AGENT_DIR` = the test dir. It builds services via
`createAgentSessionServices` and dumps `resourceLoader.getExtensions()` /
`getSkills()` plus errors. Result:

```json
{
  "isBunBinary": true,
  "extensions": [
    { "path": ".../extensions/hello.ts", "tools": ["hoy_hello"], "commands": ["hoy-hello"] },
    { "path": ".../extensions/with-deps/index.ts", "tools": ["hoy_parse_duration"], "commands": [] }
  ],
  "extensionErrors": [],
  "skills": ["hoy-greet"],
  "skillDiagnostics": [],
  "serviceDiagnostics": []
}
```

Both extensions loaded inside the compiled binary with zero errors, including the
`with-deps` extension that imports `ms` from its own node_modules.

Probe source (kept here for re-verification; it was removed from `pi-src` so it
does not ship):

```ts
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const services = await createAgentSessionServices({ cwd: process.cwd(), agentDir });
const ext = services.resourceLoader.getExtensions();
const skills = services.resourceLoader.getSkills();
console.log(JSON.stringify({
  isBunBinary: import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN"),
  extensions: ext.extensions.map((e: any) => ({ path: e.path, tools: [...e.tools.keys()], commands: [...e.commands.keys()] })),
  extensionErrors: ext.errors,
  skills: skills.skills.map((s: any) => s.name),
  skillDiagnostics: skills.diagnostics,
  serviceDiagnostics: services.diagnostics,
}, null, 2));
process.exit(0);
```

Compile + run:
```
bun build --compile --target=bun-linux-x64 pi-src/<probe>.ts --outfile /tmp/probe
PI_CODING_AGENT_DIR=/tmp/agentdir PI_PACKAGE_DIR=packages/sidecar/pi-payload /tmp/probe
```

### 3. Negative control (rules out a false positive)

Removed `extensions/with-deps/node_modules/ms` and re-ran the compiled probe. The
`with-deps` extension then failed with a clean, captured error while `hello.ts`
still loaded:

```
Failed to load extension: ResolveMessage: Cannot find package 'ms' from
'.../extensions/with-deps/index.ts'
```

This proves jiti genuinely resolves the extension's own on-disk `node_modules`
(there is no bundled/global `ms`), and that a missing dep is a fail-safe
per-extension diagnostic, not a crash of the whole loader.

### 4. End-to-end against the ACTUAL shipped binary over RPC

Built the real sidecar with `bash packages/sidecar/build.sh` (unmodified
`hoy-sidecar.ts`) and drove the produced binary
(`packages/sidecar/pi-x86_64-unknown-linux-gnu`) over the normal JSONL RPC path:
spawned it with `PI_CODING_AGENT_DIR` = the test dir and sent
`{"type":"get_commands"}`. Response contained:

- `hoy-hello` — source `extension`, `scope: "user"`, from the disk
  `extensions/hello.ts` in the branded dir.
- `hoy_mode` — the existing in-process `createHoyPermissions` factory (proves
  disk discovery coexists with `extensionFactories`).
- `skill:hoy-greet` — source `skill`, from the disk `skills/greet/SKILL.md`.

`get_commands` lists extension commands, prompt templates, and skills, not raw
tools, so tool registration (`hoy_hello`, `hoy_parse_duration`) was verified via
the probe in step 2; command + skill discovery was verified through the real RPC
binary here.

## jiti + typebox inside the compiled binary?

Yes. `isBunBinary` is `true` in the compiled artifact; `jiti/static`'s
`createJiti` runs; `typebox` (and `typebox/compile`, `typebox/value`) resolve via
`virtualModules`; an extension's own npm deps resolve from disk. Confirmed by the
positive probe, the negative control, and the real RPC binary.

## Fix / blocker

No fix needed. The plain `bun build --compile` in `build.sh` (no `--external`) is
exactly what is required: jiti/static and typebox MUST be bundled so the loader
can hand them to extensions as virtual modules. Adding `--external jiti` or
`--external typebox` would BREAK disk extension loading. This is now recorded as
a comment in `build.sh`.

## Install UX (scope item 4, not implemented, recommendation only)

A user adds an extension/skill by dropping it into the branded agent dir:

- Extension: a loose `<agentDir>/extensions/name.ts`, or
  `<agentDir>/extensions/name/` with `index.ts` (or a `package.json` whose
  `pi.extensions` lists entry files). Extensions with npm deps must have those
  deps installed into the extension's own `node_modules` (the `with-deps` shape).
- Skill: `<agentDir>/skills/name/SKILL.md` with frontmatter `name` + `description`.

Recommended first step: a settings action / menu item that opens the branded
agent dir (`~/.hoy/agent`, dev `~/.hoyd/agent`) in the OS file manager, plus docs.
A managed installer (npm/git package install via Pi's package-manager) is a
larger follow-up. The permission gate already fails safe for unknown tools, so
discovery does not weaken the security posture.

## Code changes made

Both are comment-only regression guards; behavior is unchanged (disk discovery
was already active by default).

- `packages/sidecar/pi-src/hoy-sidecar.ts` — comment at `resourceLoaderOptions`
  documenting that disk discovery from the branded `agentDir` needs no opt-in and
  coexists with the in-process `extensionFactories`, with the HOY-228 proof.
- `packages/sidecar/build.sh` — comment on the `--compile` step warning never to
  add `--external jiti`/`typebox` (they must be bundled for virtualModules), and
  noting an extension's own deps resolve from disk.

`bash packages/sidecar/build.sh` was re-run after the edits and succeeds; the
rebuilt real binary still discovers `hoy-hello`, `hoy_mode`, and
`skill:hoy-greet`.

## Guardrail / caveats

- Proven on `x86_64-unknown-linux-gnu` only. The mechanism is host-agnostic
  (bundled jiti/typebox + `$bunfs`/`~BUN` detection), but macOS/Windows targets
  were not exercised in this spike.
- This is version-sensitive. The virtualModules mechanism is Pi's; on every Pi
  version bump, re-run the reproduction above against the new compiled binary
  before claiming extension support. Add to the version-bump checklist.
- Until the install UX ships, "extension support" should not be advertised in the
  UI / README / landing page as a user-facing feature, even though the runtime is
  proven. The runtime is ready; the product surface is not.
