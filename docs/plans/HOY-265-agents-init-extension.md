# HOY-265: `/init` command to generate/refresh AGENTS.md (`createHoyInit`)

**Goal:** A built-in `/init` slash command, like Claude Code's `/init` and Codex's,
that generates an `AGENTS.md` for the user's project, or refreshes one that already
exists. The command is the deterministic shell; the agent does the exploring and
writing through its normal permission-gated `read`/`write` tools. v1 is `/init`
only: create when absent, update in place when present. No `/revise`, no
code/research/debug modes.

**Status:** Planned, not started.

## Form: an in-process extension factory (not a disk resource)

Same pattern as `createHoyMcp` / `createHoyAgents` / `createHoyAskQuestion`, per the
`AGENTS.md` "We extend Pi with in-process extension factories" decision. New
`packages/sidecar/pi-src/hoy-init.ts` exporting `createHoyInit()`, returning
`(pi: ExtensionAPI) => { pi.registerCommand("init", ...) }`, added to the
`extensionFactories` array in `hoy-sidecar.ts` and compiled into the sidecar
binary. It is NOT a disk-seeded `~/.hoy/extensions` resource (that is HOY-228's
user affordance), NOT a package, NOT a pi fork.

Command handlers run inside the `prompt` RPC, so the 15s `REQUEST_TIMEOUT`
(HOY-215) applies to the handler body. `/init` must not block on a dialog; it uses
a non-blocking `ctx.ui.notify`, then injects a user message and returns
immediately.

## Approach: handler decides mode, agent does the work

Verified against pinned pi 0.80.3 (`docs/extensions.md`): the command handler
receives `(args, ctx)` with `ctx.cwd`, `ctx.ui.notify`, `ctx.isIdle()`, and
`ctx.waitForIdle()`; message injection is `pi.sendUserMessage(content, options?)`,
which triggers an LLM response and requires a `deliverAs` while the agent is
streaming.

```ts
pi.registerCommand("init", {
  description: "Generate or update AGENTS.md for this project",
  handler: async (_args, ctx) => {
    const target = path.join(ctx.cwd, "AGENTS.md");
    const existing = readIfExists(target);            // node fs, best-effort
    const mode = existing && hasRealContent(existing) ? "update" : "create";
    ctx.ui.notify(
      mode === "update" ? "Refreshing AGENTS.md..." : "Writing AGENTS.md...",
      "info",
    );
    const prompt = buildInitPrompt(mode, ctx.cwd);
    // Do not block the handler (HOY-215). Queue as a follow-up if mid-turn.
    if (ctx.isIdle()) pi.sendUserMessage(prompt);
    else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  },
});
```

The handler never writes the file itself. The agent explores with `read`/`grep`/
`find`/`ls`/`bash` and writes `AGENTS.md` with its `write`/`edit` tools, so the
write goes through Hoy's permission gate and the user sees the diff card. This also
means `/init` needs no permission-gate change: the existing rules for `write`
already govern it.

### `hasRealContent(existing)`

Strip a UTF-8 BOM, blank lines, markdown headings, and HTML comments; if more than
~80 non-trivial characters remain, treat the file as human-authored and pick
`update`. An empty file or a bare heading-only scaffold picks `create`. (Mirrors
joenilan/pi-init's meaningful-content heuristic.)

### `buildInitPrompt(mode, cwd)`

One string, two variants sharing the same template and exploration checklist. Kept
in the sidecar (not the system prompt) so it costs nothing until `/init` runs.

Shared exploration checklist the agent is told to run first:

- Read package manifests and lockfiles (`package.json`, `Cargo.toml`,
  `pyproject.toml`, `go.mod`, etc.) to identify the stack and scripts.
- Read `README`, `CONTRIBUTING`, and any obvious top-level docs.
- Scan the directory tree for the real structure (respecting `.gitignore`); note
  the entry points and the few directories that matter.
- Find the real build / test / lint / run commands (from scripts, CI config, or
  docs), do not invent them.
- Note any existing agent config (`CLAUDE.md`, `.cursorrules`, `.github/copilot-*`)
  and fold useful facts in rather than duplicating.

Generated `AGENTS.md` shape (Claude Code / Codex convention: concise, factual,
command-first, standard headings; honors the AGENTS.md spec that scope is the
directory tree the file sits in):

```
# AGENTS.md

<one or two sentences: what this project is and its stack>

## Setup
<install / bootstrap commands, verbatim>

## Commands
<build, test, lint, run, typecheck: the real ones from this repo>

## Project structure
<the handful of directories that matter, one line each>

## Conventions
<code style, naming, patterns actually observed in the code>

## Good to know
<gotchas, non-obvious constraints; omit the section if there are none>
```

Rules baked into the prompt: keep it tight (a page, not a tour); every command must
be real and copy-pasteable; do not pad sections that have nothing to say; write the
file to `<cwd>/AGENTS.md`.

CREATE variant: write the file fresh from the template.

UPDATE variant: read the existing `AGENTS.md` first, refresh stale sections against
what the code says now, and **preserve human-authored content**, any prose, extra
sections, or notes that are not part of the template stay. Never blind-overwrite;
prefer `edit` over `write` so untouched regions are provably untouched. This is the
guardrail every reference (claude-md-management, both pi-inits, pi-onboard) shares.

## The `/init` prompt (verbatim)

`buildInitPrompt` returns one of these two strings with `<cwd>` interpolated. They
are grounded in Claude Code's `/init` (real commands + the architecture you only
get from reading several files; fold in existing agent config; do not list every
file) and Codex's AGENTS.md section set.

Provenance: Pi ships no native `/init` (v0.80.3 has only `cli/initial-message.ts`
and the `07-context-files.ts` SDK example), so there is nothing upstream to defer
to. The Pi-native `ttttmr/pi-init` skill was cross-checked; its behavior (explore
first, real commands, read-and-merge without overwriting human content, mention
existing `.cursorrules`/`CLAUDE.md`) is folded in, but its `# PROJECT KNOWLEDGE
BASE` + command-table format is deliberately not used, we keep the concise
Claude/Codex heading style per the chosen template.

**CREATE:**

```
Create an AGENTS.md at the root of this project (<cwd>): a concise guide that
helps a coding agent work in this repo. Do it in two passes.

First, explore. Do not write anything yet.
- Read the package manifests and lockfiles (package.json, Cargo.toml,
  pyproject.toml, go.mod, and so on) to identify the language, stack, and scripts.
- Read the README, CONTRIBUTING, and any top-level docs.
- Scan the directory tree, respecting .gitignore, to learn the real structure and
  the entry points.
- Determine the actual build, test, lint, run, and typecheck commands from the
  scripts, CI config, or docs. Do not invent commands; only list ones that exist.
- Skim recent git history for the commit and pull-request conventions.
- If a CLAUDE.md, .cursorrules, or .github/copilot-instructions.md exists, read it
  and fold its still-true guidance in rather than duplicating it.

Then write AGENTS.md to <cwd>/AGENTS.md with these sections. Omit any section that
has nothing real to say; do not pad.

# AGENTS.md

<one or two sentences: what this project is and its stack>

## Project structure
<the handful of directories that matter, one line each. Do not list every file.>

## Commands
<the real build, test, lint, run, and typecheck commands, each copy-pasteable.
Call out how to run a single test.>

## Coding conventions
<indentation, naming, and style patterns actually used in the code>

## Testing
<the framework, where tests live, how to run them>

## Commit and PR conventions
<what the git history and any contributing docs show>

## Good to know
<non-obvious constraints or gotchas; omit this section if there are none>

Keep it tight, about one page. Favor the big picture that takes reading several
files to grasp over facts that are obvious at a glance. Every command must be real
and copy-pasteable.
```

**UPDATE:** identical exploration and section set, with the first and last
paragraphs replaced by:

```
This project already has an AGENTS.md at <cwd>/AGENTS.md. Refresh it against the
current state of the code. Do not rewrite it from scratch.

Read <cwd>/AGENTS.md first, then explore [same checklist] to find what has drifted.

Update stale facts, commands, structure, and conventions to match what the code
says now. Preserve human-authored content: keep any prose, extra sections,
ordering, and notes that are still true, even if they are not in the section list
above. Do not delete guidance just because the template does not mention it. Use
the edit tool for targeted changes rather than rewriting the whole file, so
untouched regions stay untouched.
```

## Slice 1: the extension

- New `packages/sidecar/pi-src/hoy-init.ts`: `createHoyInit()` factory, the `init`
  command, `readIfExists`, `hasRealContent`, and `buildInitPrompt(mode, cwd)` with
  the `CREATE`/`UPDATE` template strings. Export the internals for tests
  (`_internal`), matching `hoy-ask-question.ts`.
- `hoy-sidecar.ts`: `import { createHoyInit }` and add `createHoyInit()` to the
  `extensionFactories` array (unconditional, alongside `createHoyAskQuestion()`).
  It is user-invoked via `/`, so child subagent threads never trigger it even
  though the factory is installed.
- `hoy-init.test.ts`: `hasRealContent` (empty / heading-only / real prose /
  comment-only), mode selection (missing file -> create, real file -> update),
  and `buildInitPrompt` (contains the template headings, the cwd, and the
  update-preserves-human-notes instruction only in the update variant).

**Verify:** `bun test` in `packages/sidecar/pi-src`.

## Slice 2: composer surfacing (no code)

`registerCommand` commands are returned by `get_commands` (HOY-223), so `/init`
appears in the composer `/` autocomplete automatically.

**Verify:** in the running app, `/` lists `init` with its description; selecting it
inserts the command.

## Verification and rollout

Full `check` gate (tsc, cargo check, clippy, fmt) + `bun test` in
`packages/sidecar/pi-src`. Rebuild the sidecar (`packages/sidecar/build.sh`), a
stale binary silently runs old command code (HOY-200). Live-verify in the running
app against `~/.hoyd/agent` (dev dir, DeepSeek):

1. In a project with no `AGENTS.md`, run `/init`; the agent explores and writes a
   correct, concise `AGENTS.md`; the write surfaces a permission card. Screenshot.
2. Run `/init` again; it enters update mode, refreshes, and leaves a
   hand-added note untouched.

Commit per the working process with the `HOY-265:` prefix, no push unless asked.

## Out of scope (YAGNI)

- `/revise` (capture this session's learnings into AGENTS.md), the direct analog to
  Claude Code's `/revise-claude-md`. Deferred; can be a follow-up ticket.
- code / research / debug template modes (joenilan/pi-init). Single AGENTS.md only.
- Seeding or shipping a default AGENTS.md into the agent dir; `/init` writes into
  the user's project cwd, nothing global.
- A `.draft` fallback (pi-onboard). Update mode preserves human content in place, so
  no separate draft file is needed.
