// Goal Mode v2 (HOY-298) one-shot verify-command runner. Like hoy-goal-eval,
// this is a short-lived invocation of the SAME compiled sidecar binary, selected
// by the HOY_VERIFY_COMMAND env var in hoy-sidecar.ts. Rust
// (sidecar.rs::verify_goal_command) spawns us, captures the JSON result on
// stdout, and exits us; we never reach runRpcMode. Task B's gate calls this once
// the transcript evaluator says a goal is met AND the goal pins a verifyCommand:
// the command must exit 0 for the goal to actually be declared met.
//
// SHELL INVOCATION: we run the command through Pi's OWN shell resolution rather
// than hard-coding a shell. Recon said to import Pi's `execCommand` from the
// package root, but in the pinned Pi (0.80.3) `execCommand` is NOT re-exported
// from the package root (only `getShellConfig`, `truncateTail`, and
// `createLocalBashOperations` are) and its dist subpath is blocked by the
// package `exports` map, so it cannot be imported. Instead we resolve the shell
// with the root-exported `getShellConfig()` -- the exact function Pi's real bash
// tool (createLocalBashOperations) uses -- and spawn it the same way the bash
// tool does: `spawn(shell, [...args, command])`, i.e. `/bin/bash -c "<cmd>"` on
// Unix (NOT `bash -lc`; Pi uses `-c`). We capture stdout/stderr separately with
// Node's built-in child_process.spawn (the same primitive execCommand and the
// bash tool use internally) so we can report them as distinct fields; we do not
// introduce any new generic exec surface. getShellConfig also handles the legacy
// WSL bash `commandTransport: "stdin"` case, which we mirror.
//
// FAIL-SOFT PROCESS, FAIL-CLOSED GATE: this runner ALWAYS writes a parseable
// JSON object and exits 0. A spawn failure, a timeout, or a kill emits a
// non-zero `code` (and, for timeout/kill, `killed: true`) rather than throwing
// or exiting non-zero, so Rust always gets JSON. A non-zero code means the gate
// FAILED, which Task B treats as "not met, keep working" -- the safe bias.

import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

export interface GoalVerifyResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

// Hard ceiling on how long a verify command may run before we kill it. A hung
// command must never wedge the goal loop; a kill counts as a failed gate.
const VERIFY_TIMEOUT_MS = 120_000;

// Bound each captured stream so a chatty command cannot balloon the RPC payload
// or the persisted card. We keep the TAIL, where failures and final status
// surface, and prefix a marker when we drop the head.
const MAX_STREAM_CHARS = 8000;

function truncateTail(s: string): string {
  if (s.length <= MAX_STREAM_CHARS) return s;
  const tail = s.slice(s.length - MAX_STREAM_CHARS);
  return `[... truncated ${s.length - MAX_STREAM_CHARS} chars ...]\n${tail}`;
}

function emit(result: GoalVerifyResult): never {
  process.stdout.write(
    JSON.stringify({
      code: result.code,
      stdout: truncateTail(result.stdout),
      stderr: truncateTail(result.stderr),
      killed: result.killed,
    }),
  );
  process.exit(0);
}

export async function runVerifyCommand(): Promise<never> {
  const command = process.env.HOY_VERIFY_COMMAND ?? "";
  const cwd = process.env.HOY_VERIFY_CWD?.trim() || process.cwd();

  if (!command.trim()) {
    emit({ code: -1, stdout: "", stderr: "verify error: no command provided", killed: false });
  }

  // Resolve the shell exactly as Pi's bash tool does. getShellConfig may throw on
  // a misconfigured Windows host; treat that as a failed gate rather than a crash.
  let shell: string;
  let args: string[];
  let fromStdin: boolean;
  try {
    const cfg = getShellConfig();
    shell = cfg.shell;
    args = cfg.args;
    fromStdin = cfg.commandTransport === "stdin";
  } catch (e) {
    emit({
      code: -1,
      stdout: "",
      stderr: `verify error: could not resolve shell: ${e instanceof Error ? e.message : String(e)}`,
      killed: false,
    });
  }

  const result = await new Promise<GoalVerifyResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, fromStdin ? args : [...args, command], {
        cwd,
        stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      resolve({
        code: -1,
        stdout: "",
        stderr: `verify error: could not spawn shell: ${e instanceof Error ? e.message : String(e)}`,
        killed: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;

    if (fromStdin) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(command);
    }

    const timeoutId = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      // Escalate if SIGTERM is ignored, matching execCommand's grace period.
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5000);
    }, VERIFY_TIMEOUT_MS);

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    const finish = (r: GoalVerifyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(r);
    };

    child.on("error", (e) => {
      // Spawn-level failure (e.g. shell not found): a failed gate, not a crash.
      finish({
        code: -1,
        stdout,
        stderr: stderr || `verify error: ${e instanceof Error ? e.message : String(e)}`,
        killed,
      });
    });

    child.on("close", (code, signal) => {
      // A killed (timeout) run has a null exit code; report a non-zero code so the
      // gate fails. Otherwise pass the real exit code straight through.
      const exit = code ?? (killed || signal ? -1 : 0);
      finish({ code: exit, stdout, stderr, killed });
    });
  });

  emit(result);
}
