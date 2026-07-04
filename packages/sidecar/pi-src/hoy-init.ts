// HOY-265: the `/init` command. Generates an AGENTS.md for the user's project,
// or refreshes one that already exists, in place. Modeled on Claude Code's and
// Codex's /init: the command is a deterministic shell that decides
// create-vs-update and injects a prompt.
//
// HOY-296: the prompt drives a report-first flow (like the claude-md-management
// plugin): the agent explores read-only, reports its findings plus the proposed
// AGENTS.md (or an update diff), confirms via ask_question, and only then writes
// through its normal permission-gated write/edit tools (the write card is the
// final apply gate). No handler-blocking dialog, so HOY-215's 15s prompt-RPC
// timeout does not apply.
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
- Note required environment variables and setup steps (.env.example, config files) and any services that must be running (databases, queues, containers).
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
  return `Create an AGENTS.md at the root of this project (${cwd}): a concise guide that helps a coding agent work in this repo. Work in three phases and do not write any file until the user approves.

Phase 1 - Explore, read-only. Do not write anything yet.
${EXPLORE_CHECKLIST}

Phase 2 - Report and propose. In your reply, present:
- A short findings summary: the stack, the structure that matters, the real build/test/lint/run commands you found, and anything notable or missing.
- The full proposed AGENTS.md, in a fenced code block, using these sections. Omit any section that has nothing real to say; do not pad.

${SECTION_TEMPLATE}

Keep it tight, about one page. Make it project-specific rather than generic best practice, and favor non-obvious facts (things it took reading several files to learn) over what is obvious at a glance. Every command must be real and copy-pasteable. Leave no placeholders or TBDs.

Phase 3 - Confirm, then write. Use the ask_question tool to ask whether to write the proposed AGENTS.md to ${cwd}/AGENTS.md, offering: write it, revise it first, or cancel. Only after the user approves, write the file with the write tool. If they ask for changes, revise and confirm again. Write nothing if they cancel.`;
}

function updatePrompt(cwd: string): string {
  return `This project already has an AGENTS.md at ${cwd}/AGENTS.md. Refresh it against the current state of the code. Work in three phases and do not change the file until the user approves. Do not rewrite it from scratch.

Phase 1 - Review and explore, read-only. Read ${cwd}/AGENTS.md first, then explore to find what has drifted. Do not change anything yet.
${EXPLORE_CHECKLIST}

These are the sections a good AGENTS.md has; use them as the target shape, but do not force the file into them:

${SECTION_TEMPLATE}

Phase 2 - Report and propose. In your reply, present:
- A short assessment: what in the current AGENTS.md is stale, wrong, or missing versus what the code says now. Look specifically for stale or broken commands, changed structure, missing dependencies or environment setup, broken test commands, and undocumented gotchas.
- The proposed changes as a diff (or clearly quoted before/after), each with a one-line why. Propose only genuinely useful changes: do not restate what is obvious from the code, add generic best practices, or record one-off fixes unlikely to recur. Preserve human-authored content: keep any prose, extra sections, ordering, and notes that are still true, even if they are not in the section list above. Do not delete guidance just because the template does not mention it.

Phase 3 - Confirm, then apply. Use the ask_question tool to ask whether to apply the proposed changes, offering: apply them, revise first, or cancel. Only after the user approves, make the edits with the edit tool for targeted changes rather than rewriting the whole file, so untouched regions stay provably untouched. If they ask for changes, revise and confirm again. Change nothing if they cancel.`;
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
        ctx.ui.notify(
          mode === "update" ? "Reviewing AGENTS.md for updates..." : "Drafting an AGENTS.md proposal...",
          "info",
        );
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
