// Unit tests for the gate policy table plus the HOY-186 verify-first spike:
// spawn the real sidecar entry over JSONL stdio (no LLM, no API key) and prove
// that /hoy_mode routes to the extension command with its argument, executes
// immediately, and emits an observable notify. Run with: bun test (in
// sidecar/pi-src)

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, type PermissionMode } from "./hoy-permissions";

describe("gate policy table", () => {
  const table: Array<[PermissionMode, string, string]> = [
    ["default", "read", "allow"],
    ["default", "grep", "allow"],
    ["default", "find", "allow"],
    ["default", "ls", "allow"],
    ["default", "edit", "ask"],
    ["default", "write", "ask"],
    ["default", "bash", "ask"],
    ["default", "some_custom_tool", "ask"],
    ["acceptEdits", "edit", "allow"],
    ["acceptEdits", "write", "allow"],
    ["acceptEdits", "bash", "ask"],
    ["acceptEdits", "some_custom_tool", "ask"],
    ["plan", "read", "allow"],
    ["plan", "grep", "allow"],
    ["plan", "edit", "block"],
    ["plan", "write", "block"],
    ["plan", "bash", "block"],
    ["plan", "some_custom_tool", "block"],
    ["autonomous", "edit", "allow"],
    ["autonomous", "bash", "allow"],
    ["autonomous", "some_custom_tool", "allow"],
  ];
  for (const [mode, tool, expected] of table) {
    test(`${mode} / ${tool} -> ${expected}`, () => {
      expect(decide(mode, tool)).toBe(expected);
    });
  }
});

// Spike: drive the real entry over stdio. Collect every JSONL record on
// stdout; helpers wait for a record matching a predicate.
describe("/hoy_mode over RPC", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "hoy-rpc-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "hoy-rpc-cwd-"));

  const child = Bun.spawn(["bun", join(import.meta.dir, "hoy-sidecar.ts")], {
    cwd,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      HOY_PERMISSION_MODE: "default",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const records: any[] = [];
  let buffer = "";
  const reader = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) records.push(JSON.parse(line));
      }
    }
  })();

  function send(obj: unknown) {
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  async function waitFor(pred: (r: any) => boolean, ms = 15000): Promise<any> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = records.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out; saw: ${JSON.stringify(records.slice(-5))}`);
  }

  afterAll(async () => {
    child.kill();
    await reader.catch(() => {});
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("get_commands lists hoy_mode", async () => {
    send({ type: "get_commands", id: "t1" });
    const resp = await waitFor((r) => r.type === "response" && r.id === "t1");
    expect(resp.success).toBe(true);
    const names = (resp.data?.commands ?? []).map((c: any) => c.name);
    expect(names).toContain("hoy_mode");
  });

  test("prompt /hoy_mode plan executes immediately and notifies", async () => {
    send({ type: "prompt", message: "/hoy_mode plan", id: "t2" });
    const notify = await waitFor(
      (r) => r.type === "extension_ui_request" && r.method === "notify",
    );
    expect(notify.message).toBe("permission mode: plan");
  });

  test("prompt /hoy_mode bogus notifies an error and keeps the old mode", async () => {
    send({ type: "prompt", message: "/hoy_mode bogus", id: "t3" });
    const notify = await waitFor(
      (r) =>
        r.type === "extension_ui_request" &&
        r.method === "notify" &&
        typeof r.message === "string" &&
        r.message.includes("bogus"),
    );
    expect(notify.notifyType).toBe("error");
  });
});
