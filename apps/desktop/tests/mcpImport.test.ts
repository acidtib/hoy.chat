import { describe, expect, test } from "bun:test";

import { parseMcpServersJson } from "@/lib/mcpImport";

describe("parseMcpServersJson (HOY-273)", () => {
  test("mcpServers wrapper with a stdio server", () => {
    const json = JSON.stringify({
      mcpServers: {
        linear: {
          command: "bunx",
          args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
        },
      },
    });
    expect(parseMcpServersJson(json)).toEqual([
      {
        name: "linear",
        spec: {
          command: "bunx",
          args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
        },
      },
    ]);
  });

  test("http server keeps url + headers, drops empty extras", () => {
    const json = JSON.stringify({
      mcpServers: {
        remote: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" } },
      },
    });
    expect(parseMcpServersJson(json)).toEqual([
      {
        name: "remote",
        spec: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" } },
      },
    ]);
  });

  test("stdio env passes through; empty args/env are omitted", () => {
    const json = JSON.stringify({
      mcpServers: { db: { command: "server", args: [], env: { TOKEN: "${DB}" } } },
    });
    expect(parseMcpServersJson(json)).toEqual([
      { name: "db", spec: { command: "server", env: { TOKEN: "${DB}" } } },
    ]);
  });

  test("adds every server in the config", () => {
    const json = JSON.stringify({
      mcpServers: {
        a: { command: "a" },
        b: { url: "https://b" },
      },
    });
    expect(parseMcpServersJson(json).map((s) => s.name)).toEqual(["a", "b"]);
  });

  test("bare name → server map (no wrapper)", () => {
    const json = JSON.stringify({ linear: { command: "bunx" } });
    expect(parseMcpServersJson(json)).toEqual([
      { name: "linear", spec: { command: "bunx" } },
    ]);
  });

  test("single unnamed server uses the fallback name", () => {
    const json = JSON.stringify({ command: "bunx", args: ["x"] });
    expect(parseMcpServersJson(json, "mine")).toEqual([
      { name: "mine", spec: { command: "bunx", args: ["x"] } },
    ]);
  });

  test("single unnamed server with no fallback name throws", () => {
    expect(() => parseMcpServersJson(JSON.stringify({ command: "bunx" }))).toThrow(
      /name/i,
    );
  });

  test("a server missing command and url throws", () => {
    const json = JSON.stringify({ mcpServers: { bad: { foo: 1 } } });
    expect(() => parseMcpServersJson(json)).toThrow(/command.*url/i);
  });

  test("invalid JSON throws a helpful error", () => {
    expect(() => parseMcpServersJson("{ not json")).toThrow(/Invalid JSON/);
  });

  test("empty input throws", () => {
    expect(() => parseMcpServersJson("   ")).toThrow(/Paste an MCP/);
  });

  test("empty mcpServers throws", () => {
    expect(() => parseMcpServersJson(JSON.stringify({ mcpServers: {} }))).toThrow(
      /No servers/,
    );
  });
});
