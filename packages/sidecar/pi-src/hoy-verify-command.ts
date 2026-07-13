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
// package root, but in the pinned Pi (0.80.6) `execCommand` is NOT re-exported
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
// TEARDOWN / SELF-TERMINATION: the command a user passes (`bun test`, `cargo
// test`) forks grandchildren that inherit our stdout/stderr pipes, so killing
// only the direct bash child leaves them holding the pipe write-ends open and
// `'close'` never fires. We therefore spawn the child DETACHED (its own process
// group) and, on timeout, signal the whole GROUP (`process.kill(-pid, ...)`) --
// exactly like Pi's real bash tool. SIGTERM, then SIGKILL after a grace period,
// escalated on ACTUAL exit state (child.exitCode/signalCode), never on
// `child.killed` (which flips true the instant a signal is DISPATCHED, so a
// TERM-trapping command would otherwise never be force-killed). Finally, an
// ABSOLUTE failsafe timer emits a fail-soft result and exits UNCONDITIONALLY, so
// the one-shot ALWAYS emits parseable JSON and exits within timeout+grace no
// matter what the child does. This is what lets Rust's `.output()` (which has no
// timeout of its own, mirroring evaluate_goal) safely rely on us exiting.
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
// command must never wedge the goal loop; a kill counts as a failed gate. The
// default is 120s; HOY_VERIFY_TIMEOUT_MS overrides it (clamped to a sane range)
// so tests can drive a short timeout without waiting two minutes.
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
const MIN_VERIFY_TIMEOUT_MS = 1_000;
const MAX_VERIFY_TIMEOUT_MS = 600_000;

function resolveTimeoutMs(): number {
  const raw = process.env.HOY_VERIFY_TIMEOUT_MS;
  if (!raw) return DEFAULT_VERIFY_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_VERIFY_TIMEOUT_MS;
  return Math.min(MAX_VERIFY_TIMEOUT_MS, Math.max(MIN_VERIFY_TIMEOUT_MS, n));
}

// Grace after SIGTERM before we escalate to SIGKILL (mirrors execCommand), plus
// a small margin after which the absolute failsafe force-emits and exits.
const KILL_GRACE_MS = 5_000;
const FAILSAFE_MARGIN_MS = 1_000;

// Bound each captured stream so a chatty command cannot balloon the RPC payload
// or the persisted card. We keep the TAIL, where failures and final status
// surface, and prefix a marker noting how many head chars were dropped. The cap
// is applied WHILE reading (not once at the end) so a fork bomb of output cannot
// grow the buffer unbounded before we truncate.
const MAX_STREAM_CHARS = 8000;

function capTail(s: string): string {
  return s.length <= MAX_STREAM_CHARS ? s : s.slice(s.length - MAX_STREAM_CHARS);
}

// `buf` is already tail-capped to MAX_STREAM_CHARS; `total` is the full number of
// chars seen so we can report an accurate dropped-count marker.
function formatStream(buf: string, total: number): string {
  if (total <= MAX_STREAM_CHARS) return buf;
  return `[... truncated ${total - MAX_STREAM_CHARS} chars ...]\n${buf}`;
}

// Write the JSON result and exit 0. Uses stdout.end (not write + immediate exit)
// so the full payload flushes on a pipe before the process goes away, and guards
// against a double emit (normal close vs. the absolute failsafe timer).
let emitted = false;
function emit(result: GoalVerifyResult): never {
  if (!emitted) {
    emitted = true;
    const json = JSON.stringify({
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      killed: result.killed,
    });
    process.exitCode = 0;
    process.stdout.end(json, () => process.exit(0));
  }
  // Already emitted: do NOT write again and do NOT process.exit here (that could
  // truncate the still-flushing first write); the pending end() callback exits.
  return undefined as never;
}

export async function runVerifyCommand(): Promise<never> {
  const command = process.env.HOY_VERIFY_COMMAND ?? "";
  const cwd = process.env.HOY_VERIFY_CWD?.trim() || process.cwd();
  const timeoutMs = resolveTimeoutMs();

  if (!command.trim()) {
    return emit({ code: -1, stdout: "", stderr: "verify error: no command provided", killed: false });
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
    return emit({
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
        // Own process group on Unix so we can signal the WHOLE tree (bash plus
        // any grandchildren holding the pipes) on timeout. Windows has no groups
        // here; we fall back to child.kill().
        detached: process.platform !== "win32",
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
    let stdoutTotal = 0;
    let stderrTotal = 0;
    let killed = false;
    let settled = false;

    if (fromStdin) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(command);
    }

    // Signal the child's whole process group (negative pid) on Unix, so bash AND
    // its grandchildren die and the pipes close. Windows falls back to the
    // direct child. All wrapped in try/catch: the group may already be gone.
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && typeof child.pid === "number") {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // Group already reaped, or no permission; nothing to do.
      }
    };

    // These two escalation timers are armed only AFTER the SIGTERM fires (inside
    // the timeout callback below), never at spawn time -- otherwise, with a 120s
    // timeout and a 5s grace, a legitimately long-running command would be
    // SIGKILLed at 5s. Declared here so `finish` can clear whichever are pending.
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let failsafeTimer: ReturnType<typeof setTimeout> | undefined;

    const timeoutId = setTimeout(() => {
      killed = true;
      killGroup("SIGTERM");

      // Escalate to SIGKILL after a grace period, but only if the child has NOT
      // actually exited. We check real exit state (exitCode/signalCode), never
      // child.killed -- that flips true the instant SIGTERM is DISPATCHED, so a
      // TERM-trapping command would never be force-killed if we guarded on it.
      graceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) killGroup("SIGKILL");
      }, KILL_GRACE_MS);
      graceTimer.unref?.();

      // Absolute failsafe: if the process still has not settled a hair after the
      // SIGKILL grace, force a fail-soft result and exit UNCONDITIONALLY. Nothing
      // (an unkillable child, a wedged pipe) can make the one-shot hang past here.
      failsafeTimer = setTimeout(() => {
        if (settled) return;
        emit({
          code: -1,
          stdout: formatStream(stdout, stdoutTotal),
          stderr: `${stderr ? `${stderr}\n` : ""}verify command timed out`,
          killed: true,
        });
      }, KILL_GRACE_MS + FAILSAFE_MARGIN_MS);
      failsafeTimer.unref?.();
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      const s = d.toString();
      stdoutTotal += s.length;
      stdout = capTail(stdout + s);
    });
    child.stderr?.on("data", (d) => {
      const s = d.toString();
      stderrTotal += s.length;
      stderr = capTail(stderr + s);
    });

    const finish = (r: GoalVerifyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (graceTimer) clearTimeout(graceTimer);
      if (failsafeTimer) clearTimeout(failsafeTimer);
      resolve(r);
    };

    child.on("error", (e) => {
      // Spawn-level failure (e.g. shell not found): a failed gate, not a crash.
      finish({
        code: -1,
        stdout: formatStream(stdout, stdoutTotal),
        stderr: formatStream(stderr, stderrTotal) || `verify error: ${e instanceof Error ? e.message : String(e)}`,
        killed,
      });
    });

    child.on("close", (code, signal) => {
      // A killed (timeout) run has a null exit code; report a non-zero code so the
      // gate fails. Otherwise pass the real exit code straight through.
      const exit = code ?? (killed || signal ? -1 : 0);
      finish({
        code: exit,
        stdout: formatStream(stdout, stdoutTotal),
        stderr: formatStream(stderr, stderrTotal),
        killed,
      });
    });
  });

  return emit(result);
}
