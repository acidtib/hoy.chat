import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSubagentRegistry, enabledTypes, effectiveChildPrompt } from "./hoy-agents-registry";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "hoy-agents-"));
}
function writeAgent(dir: string, name: string, frontmatter: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n${body}`);
}

test("built-ins are always present with Phase-1 tool sets", () => {
  const reg = loadSubagentRegistry(tmp(), tmp());
  expect(reg["general-purpose"].tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write", "mcp"]);
  expect(reg["general-purpose"].body).toBeUndefined();
  expect(reg["Explore"].tools).toEqual(["read", "grep", "find", "ls"]);
  expect(reg["Explore"].body).toContain("read-only");
  expect(reg["Explore"].promptMode).toBe("replace");
});

test("project overrides global overrides built-in by name; scope reflects the winner", () => {
  const agentDir = tmp();
  const cwd = tmp();
  writeAgent(join(agentDir, "agents"), "Explore", "description: global explore", "global body");
  writeAgent(join(cwd, ".hoy", "agents"), "Explore", "description: project explore", "project body");
  const reg = loadSubagentRegistry(agentDir, cwd);
  expect(reg["Explore"].scope).toBe("project");
  expect(reg["Explore"].description).toBe("project explore");
  expect(reg["Explore"].body).toBe("project body");
});

test("agent is stripped from a type's tools (depth cap) and unknown tools dropped", () => {
  const cwd = tmp();
  writeAgent(join(cwd, ".hoy", "agents"), "Bad", "tools: [read, agent, bogus, bash]", "b");
  const reg = loadSubagentRegistry(tmp(), cwd);
  expect(reg["Bad"].tools).toEqual(["read", "bash"]);
});

test("prompt_mode defaults to replace and parses append", () => {
  const cwd = tmp();
  writeAgent(join(cwd, ".hoy", "agents"), "App", "prompt_mode: append", "x");
  writeAgent(join(cwd, ".hoy", "agents"), "Def", "description: d", "y");
  const reg = loadSubagentRegistry(tmp(), cwd);
  expect(reg["App"].promptMode).toBe("append");
  expect(reg["Def"].promptMode).toBe("replace");
});

test("model and thinking are parsed; tools omitted defaults to the general set", () => {
  const cwd = tmp();
  writeAgent(join(cwd, ".hoy", "agents"), "M", "model: sonnet\nthinking: high", "p");
  const reg = loadSubagentRegistry(tmp(), cwd);
  expect(reg["M"].model).toBe("sonnet");
  expect(reg["M"].thinking).toBe("high");
  expect(reg["M"].tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write", "mcp"]);
});

test("disabled names in subagents.json set enabled=false; enabledTypes filters them", () => {
  const cwd = tmp();
  writeAgent(join(cwd, ".hoy", "agents"), "Off", "description: d", "p");
  writeFileSync(join(cwd, ".hoy", "subagents.json"), JSON.stringify({ disabled: ["Off"] }));
  const reg = loadSubagentRegistry(tmp(), cwd);
  expect(reg["Off"].enabled).toBe(false);
  expect(enabledTypes(reg).find((t) => t.name === "Off")).toBeUndefined();
  expect(enabledTypes(reg).find((t) => t.name === "Explore")).toBeDefined();
});

test("frontmatter enabled:false ships a type disabled by default (HOY-244)", () => {
  const cwd = tmp();
  writeAgent(join(cwd, ".hoy", "agents"), "Shy", "description: d\nenabled: false", "p");
  writeAgent(join(cwd, ".hoy", "agents"), "On", "description: d", "p");
  const reg = loadSubagentRegistry(tmp(), cwd);
  expect(reg["Shy"].enabled).toBe(false);
  expect(reg["On"].enabled).toBe(true);
  expect(enabledTypes(reg).find((t) => t.name === "Shy")).toBeUndefined();
});

test("subagents.json enabled[] forces a frontmatter-disabled type back on (HOY-244)", () => {
  const cwd = tmp();
  writeAgent(join(cwd, ".hoy", "agents"), "Shy", "description: d\nenabled: false", "p");
  writeFileSync(join(cwd, ".hoy", "subagents.json"), JSON.stringify({ enabled: ["Shy"] }));
  const reg = loadSubagentRegistry(tmp(), cwd);
  expect(reg["Shy"].enabled).toBe(true);
  expect(enabledTypes(reg).find((t) => t.name === "Shy")).toBeDefined();
});

test("project overlay wins over global for enable/disable (HOY-244)", () => {
  const agentDir = tmp();
  const cwd = tmp();
  writeAgent(join(cwd, ".hoy", "agents"), "X", "description: d", "p");
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ disabled: ["X"] }));
  writeFileSync(join(cwd, ".hoy", "subagents.json"), JSON.stringify({ enabled: ["X"] }));
  const reg = loadSubagentRegistry(agentDir, cwd);
  expect(reg["X"].enabled).toBe(true);
});

test("malformed frontmatter is skipped, others still load", () => {
  const cwd = tmp();
  mkdirSync(join(cwd, ".hoy", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".hoy", "agents", "Broken.md"), "---\n: : bad yaml : :\n---\nbody");
  writeAgent(join(cwd, ".hoy", "agents"), "Good", "description: ok", "p");
  const reg = loadSubagentRegistry(tmp(), cwd);
  expect(reg["Good"]).toBeDefined();
  expect(reg["Broken"]).toBeUndefined();
  expect(reg["general-purpose"]).toBeDefined();
});

test("effectiveChildPrompt: replace uses the body, append concatenates, none uses base", () => {
  const base = "BASE";
  expect(effectiveChildPrompt({ name: "a", scope: "builtin", tools: [], promptMode: "replace", body: "BODY", enabled: true }, base)).toBe("BODY");
  expect(effectiveChildPrompt({ name: "b", scope: "builtin", tools: [], promptMode: "append", body: "BODY", enabled: true }, base)).toBe("BASE\n\nBODY");
  expect(effectiveChildPrompt({ name: "c", scope: "builtin", tools: [], promptMode: "replace", enabled: true }, base)).toBe("BASE");
});
