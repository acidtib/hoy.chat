import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { inheritTrust, mainCheckout } from "./hoy-worktree";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

function repoWithWorktree() {
  const base = mkdtempSync(join(tmpdir(), "hoy-wt-"));
  const repo = join(base, "repo");
  const wt = join(base, "wt");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "worktree", "add", "-q", "-b", "hoy/x", wt);
  return { base, repo, wt };
}

test("a linked worktree resolves to its main checkout; the checkout to itself", () => {
  const { base, repo, wt } = repoWithWorktree();
  expect(mainCheckout(wt)).toBe(repo);
  expect(mainCheckout(repo)).toBe(repo);
  expect(mainCheckout(base)).toBe(base);
});

test("a worktree inherits the main checkout's trust decision", () => {
  const { repo, wt } = repoWithWorktree();
  const agentDir = mkdtempSync(join(tmpdir(), "hoy-agent-"));
  const store = new ProjectTrustStore(agentDir);
  store.set(repo, true);
  inheritTrust(agentDir, wt, repo);
  expect(store.get(wt)).toBe(true);
});
