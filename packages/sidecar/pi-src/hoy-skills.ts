// HOY-392: built-in skills compiled into the sidecar. Every Hoy user gets five
// working skills (code-review, commit, pr, security-review, simplify) with no
// setup. The markdown is embedded via bun text imports (also embedded by
// bun build --compile, so dev, tests, and the binary all agree) and staged to
// <agentDir>/builtin-skills/<name>/SKILL.md at session start. Same-named user
// (~/.hoy/skills) or project (.hoy/skills) skills win automatically: Pi's
// loadSkills is first-wins by name and disk paths load before extension paths,
// so the built-in loses the collision and the panel explains it.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codeReviewMd from "./skills/code-review/SKILL.md" with { type: "text" };
import commitMd from "./skills/commit/SKILL.md" with { type: "text" };
import prMd from "./skills/pr/SKILL.md" with { type: "text" };
import securityReviewMd from "./skills/security-review/SKILL.md" with { type: "text" };
import simplifyMd from "./skills/simplify/SKILL.md" with { type: "text" };

export const BUILTIN_SKILL_NAMES = [
  "code-review",
  "commit",
  "pr",
  "security-review",
  "simplify",
] as const;

const BUILTIN_SKILL_BODIES: Record<string, string> = {
  "code-review": codeReviewMd,
  commit: commitMd,
  pr: prMd,
  "security-review": securityReviewMd,
  simplify: simplifyMd,
};

export function builtinSkillsDir(agentDir: string): string {
  return join(agentDir, "builtin-skills");
}

export function isBuiltinSkillPath(filePath: string, agentDir: string): boolean {
  const dir = builtinSkillsDir(agentDir);
  return filePath === dir || filePath.startsWith(dir + sep);
}

// Write each built-in SKILL.md under the staging dir, touching nothing whose
// content already matches. Returns the staged skill dirs (missing ones omitted
// on failure). Fail-soft: a broken staging dir must never block session start.
export function ensureBuiltinSkills(agentDir: string): string[] {
  const staged: string[] = [];
  try {
    for (const name of BUILTIN_SKILL_NAMES) {
      const dir = join(builtinSkillsDir(agentDir), name);
      const file = join(dir, "SKILL.md");
      mkdirSync(dir, { recursive: true });
      let existing: string | null = null;
      try {
        existing = readFileSync(file, "utf8");
      } catch {
        existing = null;
      }
      if (existing !== BUILTIN_SKILL_BODIES[name]) {
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, BUILTIN_SKILL_BODIES[name], "utf8");
        renameSync(tmp, file);
      }
      staged.push(dir);
    }
  } catch (e) {
    console.error(`hoy-skills: could not stage built-in skills: ${e}`);
  }
  return staged;
}

export function createHoySkills(agentDir: string) {
  return function hoySkills(pi: ExtensionAPI) {
    pi.on("resources_discover", () => ({ skillPaths: ensureBuiltinSkills(agentDir) }));
  };
}
