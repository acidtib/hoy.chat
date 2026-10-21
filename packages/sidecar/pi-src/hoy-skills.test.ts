// HOY-392: built-in skills compiled into the sidecar. Covers staging
// (all five materialize with exact content), idempotency (a second pass
// rewrites nothing), factory wiring (one resources_discover handler listing
// five existing dirs), and precedence (a same-named user skill beats the
// built-in with a collision diagnostic). Run with: bun test (in sidecar/pi-src)

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  BUILTIN_SKILL_NAMES,
  builtinSkillsDir,
  createHoySkills,
  ensureBuiltinSkills,
  isBuiltinSkillPath,
} from "./hoy-skills";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "hoy-skills-"));
}

describe("ensureBuiltinSkills", () => {
  test("materializes all five skills with content", () => {
    const root = tempRoot();
    try {
      const staged = ensureBuiltinSkills(root);
      expect(staged).toHaveLength(BUILTIN_SKILL_NAMES.length);
      for (const name of BUILTIN_SKILL_NAMES) {
        const file = join(builtinSkillsDir(root), name, "SKILL.md");
        expect(staged).toContain(join(builtinSkillsDir(root), name));
        const body = readFileSync(file, "utf8");
        expect(body).toContain(`name: ${name}`);
        expect(body.length).toBeGreaterThan(200);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("second pass rewrites nothing", () => {
    const root = tempRoot();
    try {
      ensureBuiltinSkills(root);
      const file = join(builtinSkillsDir(root), "commit", "SKILL.md");
      const old = new Date("2020-01-01T00:00:00Z");
      utimesSync(file, old, old);
      ensureBuiltinSkills(root);
      const stat = statSync(file);
      expect(stat.mtime.getTime()).toBe(old.getTime());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repairs a modified staged file", () => {
    const root = tempRoot();
    try {
      ensureBuiltinSkills(root);
      const file = join(builtinSkillsDir(root), "pr", "SKILL.md");
      writeFileSync(file, "tampered", "utf8");
      ensureBuiltinSkills(root);
      expect(readFileSync(file, "utf8")).toContain("name: pr");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isBuiltinSkillPath", () => {
  test("matches the staging dir and its contents only", () => {
    const root = tempRoot();
    try {
      expect(isBuiltinSkillPath(join(root, "builtin-skills", "commit", "SKILL.md"), root)).toBe(true);
      expect(isBuiltinSkillPath(join(root, "builtin-skills"), root)).toBe(true);
      expect(isBuiltinSkillPath(join(root, "skills", "commit", "SKILL.md"), root)).toBe(false);
      expect(isBuiltinSkillPath(join(root, "builtin-skills-evil", "x", "SKILL.md"), root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("createHoySkills", () => {
  test("registers one resources_discover handler listing five existing dirs", () => {
    const root = tempRoot();
    try {
      const seen: Array<{ event: string; handler: () => unknown }> = [];
      const pi: any = { on: (event: string, handler: () => unknown) => seen.push({ event, handler }) };
      createHoySkills(root)(pi);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.event).toBe("resources_discover");
      const result = seen[0]!.handler() as { skillPaths: string[] };
      expect(result.skillPaths).toHaveLength(BUILTIN_SKILL_NAMES.length);
      for (const dir of result.skillPaths) {
        expect(statSync(join(dir, "SKILL.md")).isFile()).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("built-in precedence", () => {
  test("a same-named user skill wins with a collision diagnostic", async () => {
    const agentDir = tempRoot();
    const cwd = tempRoot();
    try {
      const userDir = join(agentDir, "skills", "commit");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(
        join(userDir, "SKILL.md"),
        "---\nname: commit\ndescription: User override wins.\n---\n\nMine.\n",
        "utf8",
      );
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        additionalSkillPaths: ensureBuiltinSkills(agentDir),
      });
      await loader.reload();
      const { skills, diagnostics } = loader.getSkills();
      const commit = skills.filter((s) => s.name === "commit");
      expect(commit).toHaveLength(1);
      expect(commit[0]!.description).toBe("User override wins.");
      const collision = diagnostics.find(
        (d) => d.type === "collision" && d.message.includes('"commit"'),
      );
      expect(collision).toBeDefined();
      expect(JSON.stringify(collision)).toContain("builtin-skills");
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("built-ins load when no user skill collides", async () => {
    const agentDir = tempRoot();
    const cwd = tempRoot();
    try {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        additionalSkillPaths: ensureBuiltinSkills(agentDir),
      });
      await loader.reload();
      const { skills } = loader.getSkills();
      const names = skills.map((s) => s.name);
      for (const name of BUILTIN_SKILL_NAMES) {
        expect(names).toContain(name);
      }
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
