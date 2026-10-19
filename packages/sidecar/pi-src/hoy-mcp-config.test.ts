// loadConfig for Pi's built-in MCP extension: layering, project trust, the
// codemode -> deferred exposure default, legacy `disabled`, and the `mcp`
// capability expansion. Run with: bun test (in sidecar/pi-src)

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptServer, expandToolNames, loadHoyMcpConfig, MCP_TOOL_NAMES } from "./hoy-mcp-config";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "hoy-mcp-config-"));
  scratch.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".hoy"), { recursive: true });
  return { agentDir, cwd };
}

function write(path: string, servers: Record<string, unknown>) {
  writeFileSync(path, JSON.stringify({ mcpServers: servers }));
}

describe("loadHoyMcpConfig", () => {
  test("layers global < .mcp.json < .hoy/mcp.json in a trusted project", () => {
    const { agentDir, cwd } = dirs();
    write(join(agentDir, "mcp.json"), { a: { command: "global-a" }, b: { command: "global-b" } });
    write(join(cwd, ".mcp.json"), { b: { command: "shared-b" }, c: { url: "https://shared.example/mcp" } });
    write(join(cwd, ".hoy", "mcp.json"), { c: { command: "hoy-c" } });
    const loaded = loadHoyMcpConfig({ agentDir, cwd, projectTrusted: true });
    const byName = Object.fromEntries(loaded.servers.map((s) => [s.name, s]));
    expect((byName.a.config as any).command).toBe("global-a");
    expect(byName.a.scope).toBe("global");
    expect((byName.b.config as any).command).toBe("shared-b");
    expect(byName.b.scope).toBe("project");
    expect((byName.c.config as any).command).toBe("hoy-c");
    expect(loaded.errors).toEqual([]);
    expect(loaded.autoEnableCodemode).toBe(false);
    expect(loaded.projectConfig).toBe(join(cwd, ".hoy", "mcp.json"));
  });

  test("ignores project files until the project is trusted", () => {
    const { agentDir, cwd } = dirs();
    write(join(agentDir, "mcp.json"), { a: { command: "global-a" } });
    write(join(cwd, ".mcp.json"), { evil: { command: "rm" } });
    write(join(cwd, ".hoy", "mcp.json"), { evil2: { command: "rm" } });
    const loaded = loadHoyMcpConfig({ agentDir, cwd, projectTrusted: false });
    expect(loaded.servers.map((s) => s.name)).toEqual(["a"]);
    expect(loaded.projectConfig).toBeUndefined();
  });

  test("enabled:false loads nothing (subagent types without mcp)", () => {
    const { agentDir, cwd } = dirs();
    write(join(agentDir, "mcp.json"), { a: { command: "global-a" } });
    expect(loadHoyMcpConfig({ agentDir, cwd, projectTrusted: true, enabled: false }).servers).toEqual([]);
  });

  test("a project override adjusts a global server and keeps its credentials", () => {
    const { agentDir, cwd } = dirs();
    write(join(agentDir, "mcp.json"), { gh: { url: "https://gh.example/mcp", headers: { Authorization: "${GH}" } } });
    write(join(cwd, ".hoy", "mcp.json"), { gh: { enabled: false } });
    const [gh] = loadHoyMcpConfig({ agentDir, cwd, projectTrusted: true }).servers;
    expect(gh.config.enabled).toBe(false);
    expect((gh.config as any).headers).toEqual({ Authorization: "${GH}" });
    expect(gh.override).toBe(join(cwd, ".hoy", "mcp.json"));
  });

  test("reports invalid entries and malformed files without dropping valid ones", () => {
    const { agentDir, cwd } = dirs();
    write(join(agentDir, "mcp.json"), { ok: { command: "x" }, bad: { type: "sse", url: "https://x/sse" } });
    writeFileSync(join(cwd, ".hoy", "mcp.json"), "{ not json");
    const loaded = loadHoyMcpConfig({ agentDir, cwd, projectTrusted: true });
    expect(loaded.servers.map((s) => s.name)).toEqual(["ok"]);
    expect(loaded.errors.length).toBe(2);
  });

  test("project files cannot set auth", () => {
    const { agentDir, cwd } = dirs();
    write(join(cwd, ".hoy", "mcp.json"), { x: { url: "https://x.example/mcp", auth: { provider: "anthropic" } } });
    const loaded = loadHoyMcpConfig({ agentDir, cwd, projectTrusted: true });
    expect(loaded.servers).toEqual([]);
    expect(loaded.errors[0]).toContain("auth is only allowed in the global mcp.json");
  });
});

describe("adaptServer", () => {
  test("defaults exposure to deferred and maps codemode to deferred", () => {
    expect((adaptServer("a", { command: "x" }) as any).exposure).toBe("deferred");
    expect((adaptServer("a", { command: "x", exposure: "codemode" }) as any).exposure).toBe("deferred");
    expect((adaptServer("a", { command: "x", exposure: "direct" }) as any).exposure).toBe("direct");
    const tools = (adaptServer("a", { command: "x", toolExposure: { "get_*": "codemode", del: "hidden" } }) as any)
      .toolExposure;
    expect(tools).toEqual({ "get_*": "deferred", del: "hidden" });
  });

  test("maps legacy disabled:true to enabled:false and strips it", () => {
    const config = adaptServer("a", { command: "x", disabled: true }) as any;
    expect(config.enabled).toBe(false);
    expect("disabled" in config).toBe(false);
  });

  test("rejects bad shapes", () => {
    expect(typeof adaptServer("bad name", { command: "x" })).toBe("string");
    expect(typeof adaptServer("a", { url: "ftp://x" })).toBe("string");
    expect(typeof adaptServer("a", { command: "x", args: "nope" })).toBe("string");
    expect(typeof adaptServer("a", { command: "x", exposure: "loud" })).toBe("string");
    expect(typeof adaptServer("a", {})).toBe("string");
  });
});

describe("expandToolNames", () => {
  test("replaces the mcp capability with Pi's MCP tool names", () => {
    expect(expandToolNames(["read", "mcp", "agent"])).toEqual(["read", ...MCP_TOOL_NAMES, "agent"]);
    expect(expandToolNames(["read"])).toEqual(["read"]);
  });
});
