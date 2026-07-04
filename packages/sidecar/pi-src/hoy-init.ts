// HOY-265: the `/init` command. Generates an AGENTS.md for the user's project,
// or refreshes one that already exists, in place. Modeled on Claude Code's and
// Codex's /init: the command is a deterministic shell that decides
// create-vs-update and injects a prompt; the agent does the exploring and
// writing through its normal permission-gated read/write tools, so the write
// surfaces the usual diff card and needs no permission-gate change.
//
// Registered unconditionally in hoy-sidecar.ts. It is a user-invoked command
// (surfaced in the composer `/` autocomplete via get_commands, HOY-223), so
// child subagent threads never fire it even though the factory is installed.
// The handler must not block on a dialog: the `prompt` RPC times out at 15s
// (HOY-215), so /init only notifies, injects a user message, and returns.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type InitMode = "create" | "update";

// Best-effort read; a missing (or unreadable) file means "no AGENTS.md yet".
function readIfExists(target: string): string | null {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

// An AGENTS.md that carries human-authored substance picks update mode so we
// preserve it. Strip a BOM, HTML comments, blank lines, and markdown headings;
// if more than ~80 non-whitespace characters remain, treat it as real content.
// A bare heading-only scaffold or an empty file falls through to create.
function hasRealContent(existing: string): boolean {
  const body = existing
    .replace(/^﻿/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join("");
  return body.replace(/\s+/g, "").length > 80;
}

// Kept here, not in the system prompt, so it costs nothing until /init runs.
const EXPLORE_CHECKLIST = `- Read the package manifests and lockfiles (package.json, Cargo.toml, pyproject.toml, go.mod, and so on) to identify the language, stack, and scripts.
- Read the README, CONTRIBUTING, and any top-level docs.
- Scan the directory tree, respecting .gitignore, to learn the real structure and the entry points.
- Determine the actual build, test, lint, run, and typecheck commands from the scripts, CI config, or docs. Do not invent commands; only list ones that exist.
- Skim recent git history for the commit and pull-request conventions.
- If a CLAUDE.md, .cursorrules, or .github/copilot-instructions.md exists, read it and fold its still-true guidance in rather than duplicating it.`;

const SECTION_TEMPLATE = `# AGENTS.md

<one or two sentences: what this project is and its stack>

## Project structure
<the handful of directories that matter, one line each. Do not list every file.>

## Commands
<the real build, test, lint, run, and typecheck commands, each copy-pasteable. Call out how to run a single test.>

## Coding conventions
<indentation, naming, and style patterns actually used in the code>

## Testing
<the framework, where tests live, how to run them>

## Commit and PR conventions
<what the git history and any contributing docs show>

## Good to know
<non-obvious constraints or gotchas; omit this section if there are none>`;

function createPrompt(cwd: string): string {
  return `Create an AGENTS.md at the root of this project (${cwd}): a concise guide that helps a coding agent work in this repo. Do it in two passes.

First, explore. Do not write anything yet.
${EXPLORE_CHECKLIST}

Then write AGENTS.md to ${cwd}/AGENTS.md with these sections. Omit any section that has nothing real to say; do not pad.

${SECTION_TEMPLATE}

Keep it tight, about one page. Favor the big picture that takes reading several files to grasp over facts that are obvious at a glance. Every command must be real and copy-pasteable.`;
}

function updatePrompt(cwd: string): string {
  return `This project already has an AGENTS.md at ${cwd}/AGENTS.md. Refresh it against the current state of the code. Do not rewrite it from scratch.

Read ${cwd}/AGENTS.md first, then explore to find what has drifted. Do not change anything until you have read both the existing file and the code.
${EXPLORE_CHECKLIST}

These are the sections a good AGENTS.md has; use them as the target shape, but do not force the file into them:

${SECTION_TEMPLATE}

Update stale facts, commands, structure, and conventions to match what the code says now. Preserve human-authored content: keep any prose, extra sections, ordering, and notes that are still true, even if they are not in the section list above. Do not delete guidance just because the template does not mention it. Use the edit tool for targeted changes rather than rewriting the whole file, so untouched regions stay provably untouched.`;
}

function buildInitPrompt(mode: InitMode, cwd: string): string {
  return mode === "update" ? updatePrompt(cwd) : createPrompt(cwd);
}

export function createHoyInit() {
  return function hoyInit(pi: ExtensionAPI) {
    pi.registerCommand("init", {
      description: "Generate or update AGENTS.md for this project",
      handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const target = join(ctx.cwd, "AGENTS.md");
        const existing = readIfExists(target);
        const mode: InitMode = existing !== null && hasRealContent(existing) ? "update" : "create";
        ctx.ui.notify(mode === "update" ? "Refreshing AGENTS.md..." : "Writing AGENTS.md...", "info");
        const prompt = buildInitPrompt(mode, ctx.cwd);
        // Do not block the handler (HOY-215). sendUserMessage always triggers a
        // turn; when idle it sends immediately, so deliverAs is only needed to
        // queue behind a turn that is mid-stream (omitting it then throws).
        if (ctx.isIdle()) pi.sendUserMessage(prompt);
        else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      },
    });
  };
}

// Exposed for tests.
export const _internal = { readIfExists, hasRealContent, buildInitPrompt };
