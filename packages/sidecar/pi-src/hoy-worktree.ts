// HOY-358: a delegated issue runs in a git worktree outside the repo. Hoy's
// project config (.hoy agents, settings, MCP) is untracked or local, so it is
// read from the main checkout, and the worktree inherits that checkout's trust
// decision so an unattended run never stops at pi's trust prompt.
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// The main checkout when `cwd` is a linked worktree, else `cwd`.
export function mainCheckout(cwd: string): string {
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!common || !top || basename(common) !== ".git") return cwd;
  const main = dirname(common);
  return resolve(main) === resolve(top) ? cwd : main;
}

// Copy the main checkout's trust decision onto the worktree when the worktree
// has none of its own.
export function inheritTrust(agentDir: string, cwd: string, root: string): void {
  if (resolve(root) === resolve(cwd)) return;
  try {
    const store = new ProjectTrustStore(agentDir);
    if (store.get(cwd) !== null) return;
    const decision = store.get(root);
    if (decision !== null) store.set(cwd, decision);
  } catch {
    // Trust stays undecided; pi asks as it would for any new folder.
  }
}
