// HOY-298 teardown regression tests for the verify-command one-shot. This is
// where the Critical bug hid: a command that traps/ignores SIGTERM must still be
// force-killed (SIGKILL to the whole process group) so the one-shot NEVER hangs.
// We drive the real sidecar entry as a subprocess (the exact shape Rust spawns),
// with a short HOY_VERIFY_TIMEOUT_MS, and assert it returns PROMPTLY with a
// non-zero code -- well under the command's own sleep. Run with: bun test
// (in sidecar/pi-src).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "hoy-sidecar.ts");

interface RunResult {
  json: { code: number; stdout: string; stderr: string; killed: boolean };
  elapsedMs: number;
}

// Spawn the one-shot exactly as sidecar.rs::verify_goal_command does: set
// HOY_VERIFY_COMMAND (+ optional short timeout) and read the single JSON object
// off stdout. Returns the parsed result and how long the process took to exit.
async function runOneShot(command: string, timeoutMs?: number): Promise<RunResult> {
  const agentDir = mkdtempSync(join(tmpdir(), "hoy-verify-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "hoy-verify-cwd-"));
  const start = Date.now();
  try {
    const child = Bun.spawn(["bun", ENTRY], {
      cwd,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        HOY_CODING_AGENT_DIR: agentDir,
        HOY_VERIFY_COMMAND: command,
        HOY_VERIFY_CWD: cwd,
        ...(timeoutMs ? { HOY_VERIFY_TIMEOUT_MS: String(timeoutMs) } : {}),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    await child.exited;
    const elapsedMs = Date.now() - start;
    return { json: JSON.parse(stdout.trim()), elapsedMs };
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("verify-command one-shot teardown", () => {
  // The Critical: a TERM-trapping `sleep 30` must be force-killed via SIGKILL to
  // the group at the grace boundary. If the old dead-code escalation were still
  // here, this would hang for 30s and blow the test timeout. It must return in a
  // few seconds (1s timeout + 5s grace), far under the 30s sleep.
  test(
    "force-kills a SIGTERM-trapping command and returns promptly",
    async () => {
      const { json, elapsedMs } = await runOneShot("trap '' TERM; sleep 30", 1000);
      expect(json.killed).toBe(true);
      expect(json.code).not.toBe(0);
      // Well under the 30s sleep: proves we did not wait for the command itself.
      expect(elapsedMs).toBeLessThan(20_000);
    },
    30_000,
  );

  // Happy path still emits {code:0}; the teardown changes do not regress a normal
  // fast command (and it returns far under any timeout).
  test("passes a zero-exit command through as code 0", async () => {
    const { json, elapsedMs } = await runOneShot("echo hi; exit 0");
    expect(json.code).toBe(0);
    expect(json.stdout).toContain("hi");
    expect(json.killed).toBe(false);
    expect(elapsedMs).toBeLessThan(15_000);
  });

  // A non-zero exit passes straight through (a failed gate), not remapped.
  test("passes a non-zero exit code through unchanged", async () => {
    const { json } = await runOneShot("exit 3");
    expect(json.code).toBe(3);
    expect(json.killed).toBe(false);
  });

  // Regression: the SIGKILL grace timer must be armed only AFTER SIGTERM, never
  // at spawn. A command that runs LONGER than the 5s grace but finishes before
  // the (default 120s) timeout must complete normally, not be killed at 5s.
  test(
    "does not kill a legitimately long command that outlives the grace window",
    async () => {
      const { json } = await runOneShot("sleep 6; echo done; exit 0");
      expect(json.killed).toBe(false);
      expect(json.code).toBe(0);
      expect(json.stdout).toContain("done");
    },
    20_000,
  );

  // Empty command is a fail-soft failed gate, not a crash.
  test("emits a failed gate for an empty command", async () => {
    const { json } = await runOneShot("   ");
    expect(json.code).not.toBe(0);
    expect(json.stderr).toContain("no command");
  });
});
