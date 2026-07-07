// Unit tests for the MCP extension (HOY-232). Two parts:
// - mergeConfigs: pure precedence + scope tagging + ${ENV} interpolation.
// - the `mcp` proxy tool driven directly against a REAL stdio MCP server
//   (mcp-test-server.mjs), covering search/describe/call, per-server connect
//   consent, per-tool call consent + caching, deny paths, and project-trust
//   gating of project-scoped servers.
// Run with: bun test  (in sidecar/pi-src)

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createHoyMcp, mergeConfigs, mergeLayers, resolveCommand, type McpConfig } from "./hoy-mcp";
import { buildHoySystemPrompt } from "./hoy-system-prompt";

const TEST_SERVER = join(import.meta.dir, "mcp-test-server.mjs");

function stdioConfig(scope: "global" | "project" = "global"): McpConfig {
  return { servers: [{ name: "test", scope, spec: { command: "node", args: [TEST_SERVER] } }] };
}

// Mount createHoyMcp with a fake ExtensionAPI, capturing the registered tool
// and the session_shutdown handler.
function mount(config: McpConfig) {
  let tool: any;
  let shutdown: (() => Promise<void>) | undefined;
  const pi: any = {
    registerTool: (t: any) => {
      tool = t;
    },
    registerCommand: () => {},
    on: (event: string, handler: any) => {
      if (event === "session_shutdown") shutdown = handler;
    },
  };
  createHoyMcp(config)(pi);
  return { tool, shutdown: async () => shutdown?.() };
}

function ctx(opts: { select?: (title: string, options: string[]) => Promise<string>; trusted?: boolean } = {}) {
  return {
    ui: { select: opts.select ?? (async () => "Allow"), notify: () => {} },
    isProjectTrusted: () => opts.trusted ?? true,
  } as any;
}

describe("mergeConfigs", () => {
  test("tags scope and drops disabled servers", () => {
    const merged = mergeConfigs(
      { mcpServers: { a: { command: "x" }, off: { command: "y", disabled: true } } },
      { mcpServers: { b: { url: "https://example.com" } } },
      {},
    );
    const names = merged.servers.map((s) => `${s.name}:${s.scope}`).sort();
    expect(names).toEqual(["a:global", "b:project"]);
  });

  test("project wins on name collision and takes project scope", () => {
    const merged = mergeConfigs(
      { mcpServers: { dup: { command: "global-cmd" } } },
      { mcpServers: { dup: { command: "project-cmd" } } },
      {},
    );
    expect(merged.servers).toHaveLength(1);
    expect(merged.servers[0].scope).toBe("project");
    expect((merged.servers[0].spec as any).command).toBe("project-cmd");
  });

  test("interpolates ${ENV} in string values, missing -> empty", () => {
    const merged = mergeConfigs(
      { mcpServers: { s: { command: "run", env: { TOKEN: "${SECRET}", MISS: "${NOPE}" } } } },
      {},
      { SECRET: "abc123" } as any,
    );
    const env = (merged.servers[0].spec as any).env;
    expect(env.TOKEN).toBe("abc123");
    expect(env.MISS).toBe("");
  });

  test("$${VAR} escapes to a literal ${VAR}", () => {
    const merged = mergeConfigs(
      { mcpServers: { s: { command: "run", env: { LIT: "$${SECRET}" } } } },
      {},
      { SECRET: "abc123" } as any,
    );
    expect((merged.servers[0].spec as any).env.LIT).toBe("${SECRET}");
  });

  test("mergeLayers: .hoy/mcp.json wins over .mcp.json wins over global; both project-scoped", () => {
    const merged = mergeLayers(
      [
        { config: { mcpServers: { dup: { command: "global" }, g: { command: "g" } } }, scope: "global" },
        { config: { mcpServers: { dup: { command: "generic" }, s: { command: "shared" } } }, scope: "project" },
        { config: { mcpServers: { dup: { command: "branded" } } }, scope: "project" },
      ],
      {},
    );
    const dup = merged.servers.find((x) => x.name === "dup")!;
    expect((dup.spec as any).command).toBe("branded");
    expect(dup.scope).toBe("project");
    // the standard .mcp.json server is present and project-scoped (trust-gated)
    const shared = merged.servers.find((x) => x.name === "s")!;
    expect(shared.scope).toBe("project");
  });
});

describe("mcp proxy tool (real stdio server)", () => {
  test("registers a tool named mcp", () => {
    const { tool } = mount(stdioConfig());
    expect(tool.name).toBe("mcp");
  });

  test("search lists tools from the server", async () => {
    const { tool, shutdown } = mount(stdioConfig());
    const res = await tool.execute("c1", { action: "search" }, undefined, undefined, ctx());
    const text = res.content[0].text as string;
    expect(text).toContain("test/echo");
    expect(text).toContain("test/add");
    await shutdown();
  });

  test("describe returns a tool's input schema", async () => {
    const { tool, shutdown } = mount(stdioConfig());
    const res = await tool.execute("c2", { action: "describe", server: "test", tool: "echo" }, undefined, undefined, ctx());
    const parsed = JSON.parse(res.content[0].text as string);
    expect(parsed.name).toBe("echo");
    expect(parsed.inputSchema).toBeDefined();
    await shutdown();
  });

  test("call invokes the tool and returns its result", async () => {
    const { tool, shutdown } = mount(stdioConfig());
    const res = await tool.execute(
      "c3",
      { action: "call", server: "test", tool: "echo", args: { text: "hi" } },
      undefined,
      undefined,
      ctx(),
    );
    expect(res.content[0].text).toBe("echo: hi");
    await shutdown();
  });

  test("empty config reports no servers", async () => {
    const { tool, shutdown } = mount({ servers: [] });
    const res = await tool.execute("c4", { action: "search" }, undefined, undefined, ctx());
    expect(res.content[0].text).toContain("No MCP servers");
    await shutdown();
  });

  test("denying the connect consent blocks the server", async () => {
    const { tool, shutdown } = mount(stdioConfig());
    let asked = false;
    const c = ctx({
      select: async () => {
        asked = true;
        return "Deny";
      },
    });
    await expect(tool.execute("c5", { action: "search" }, undefined, undefined, c)).resolves.toBeDefined();
    // search swallows per-server errors into the summary; assert it surfaced the decline
    const res = await tool.execute("c5b", { action: "search" }, undefined, undefined, c);
    expect(res.content[0].text).toContain("unavailable");
    expect(asked).toBe(true);
    await shutdown();
  });

  test("call asks connect consent once, then per-tool consent, cached for the session", async () => {
    const { tool, shutdown } = mount(stdioConfig());
    const prompts: string[] = [];
    const c = ctx({
      select: async (title: string) => {
        prompts.push(title);
        return title.includes("Run MCP tool") ? "Allow for this session" : "Allow";
      },
    });
    await tool.execute("c6", { action: "call", server: "test", tool: "echo", args: { text: "1" } }, undefined, undefined, c);
    await tool.execute("c7", { action: "call", server: "test", tool: "echo", args: { text: "2" } }, undefined, undefined, c);
    // connect consent once + tool consent once; second call reuses both grants
    expect(prompts.filter((p) => p.startsWith("Start MCP server"))).toHaveLength(1);
    expect(prompts.filter((p) => p.startsWith("Run MCP tool"))).toHaveLength(1);
    await shutdown();
  });

  test("system prompt advertises the mcp tool only when servers are configured", () => {
    expect(buildHoySystemPrompt(false)).not.toContain("MCP tools:");
    const configured = buildHoySystemPrompt(true);
    expect(configured).toContain("MCP tools:");
    expect(configured).toContain('mcp({action:"search"})');
  });

  test("project-scoped server is blocked when the project is untrusted", async () => {
    const { tool, shutdown } = mount(stdioConfig("project"));
    const c = ctx({ trusted: false });
    const res = await tool.execute("c8", { action: "search" }, undefined, undefined, c);
    expect(res.content[0].text).toContain("not trusted");
    await shutdown();
  });

  test("system prompt advertises enabled agent types dynamically", () => {
    expect(buildHoySystemPrompt(false, false)).not.toContain("Subagents:");
    const enabled = buildHoySystemPrompt(false, true, [
      { name: "Explore", description: "read-only" },
      { name: "Reviewer", description: "reviews diffs" },
    ]);
    expect(enabled).toContain("Subagents:");
    expect(enabled).toContain("Explore");
    expect(enabled).toContain("Reviewer");
    expect(enabled).toContain("reviews diffs");
    // HOY-300: the agent tool is synchronous — the prompt tells the model the
    // call blocks and returns the subagent's result in-band (not "delivered back").
    expect(enabled).toContain("BLOCKS until the subagent finishes and returns its result");
    expect(enabled).not.toContain("Fire-and-forget");
  });
});

describe("resolveCommand", () => {
  test("absolute path is returned as-is", () => {
    expect(resolveCommand("/usr/bin/node", { PATH: "" })).toBe("/usr/bin/node");
  });

  test("relative path with separator is returned as-is", () => {
    expect(resolveCommand("./my-server", { PATH: "" })).toBe("./my-server");
    expect(resolveCommand("subdir/server", { PATH: "" })).toBe("subdir/server");
  });

  test("Windows absolute path is returned as-is", () => {
    expect(resolveCommand("C:\\Users\\foo\\server.exe", { PATH: "" })).toBe("C:\\Users\\foo\\server.exe");
    expect(resolveCommand("D:\\tools\\bunx.cmd", { PATH: "" })).toBe("D:\\tools\\bunx.cmd");
  });

  test("Windows path with backslash separator is returned as-is", () => {
    expect(resolveCommand("subdir\\server", { PATH: "" })).toBe("subdir\\server");
  });

  test("resolves command from PATH", () => {
    // "node" should be in PATH on any system with Node installed
    const result = resolveCommand("node", { PATH: process.env.PATH });
    expect(result).toContain("node");
    expect(result.startsWith("/")).toBe(true);
  });

  test("throws descriptive error for missing command", () => {
    try {
      resolveCommand("definitely-not-a-real-command-abc123", { PATH: "/usr/bin:/bin" });
      expect(true).toBe(false); // should not reach here
    } catch (e) {
      expect((e as Error).message).toContain("definitely-not-a-real-command-abc123");
      expect((e as Error).message).toContain("not found in PATH");
      expect((e as Error).message).toContain("Searched:");
      expect((e as Error).message).toContain("/usr/bin");
    }
  });

  test("throws on empty PATH", () => {
    expect(() => resolveCommand("node", { PATH: "" })).toThrow("not found in PATH");
    expect(() => resolveCommand("node", { PATH: "" })).toThrow("(empty PATH)");
  });

  test("resolves command via PATHEXT extensions", () => {
    const dir = mkdtempSync("/tmp/hoy-test-pathext-");
    // Windows filesystem is case-insensitive but the test runs on Linux;
    // use lowercase extensions to match the actual filename.
    const exe = join(dir, "bunx.cmd");
    writeFileSync(exe, "", { mode: 0o755 });
    try {
      const env = { PATH: dir, PATHEXT: ".cmd;.exe;.bat;.com" };
      const result = resolveCommand("bunx", env);
      expect(result).toBe(exe);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("PATHEXT: normalizes extensions missing a leading dot", () => {
    const dir = mkdtempSync("/tmp/hoy-test-pathext2-");
    const exe = join(dir, "uvx.exe");
    writeFileSync(exe, "", { mode: 0o755 });
    try {
      const env = { PATH: dir, PATHEXT: "exe;cmd" };
      const result = resolveCommand("uvx", env);
      expect(result).toBe(exe);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
