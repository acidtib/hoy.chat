// HOY-358: a git worktree per delegated issue, so parallel Fleet runs never
// share a checkout. Worktrees live under Hoy's agent dir, not inside the repo,
// and removing one keeps its branch.
use crate::pi_config::agent_dir;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    // The branch (or commit, when detached) the worktree was created from.
    pub base: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoveOutcome {
    pub removed: bool,
    // The worktree had uncommitted changes, so it was left in place.
    pub dirty: bool,
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub fn is_git_repo(project: &str) -> bool {
    git(Path::new(project), &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s == "true")
        .unwrap_or(false)
}

// A filesystem-safe name: lowercase alphanumerics and dashes.
fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

// <agent dir>/worktrees/<repo name>-<path hash>/<branch>, so two checkouts of
// repos with the same name never collide.
fn worktree_dir(root: &Path, toplevel: &str, branch: &str) -> PathBuf {
    let mut h = DefaultHasher::new();
    toplevel.hash(&mut h);
    let name = Path::new(toplevel)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    root.join("worktrees")
        .join(format!("{}-{:08x}", slug(&name), h.finish() as u32))
        .join(slug(branch))
}

pub fn create(project: &str, branch: &str) -> Result<WorktreeInfo, String> {
    create_under(&agent_dir()?, project, branch)
}

fn create_under(root: &Path, project: &str, branch: &str) -> Result<WorktreeInfo, String> {
    let project_dir = Path::new(project);
    let toplevel = git(project_dir, &["rev-parse", "--show-toplevel"])
        .map_err(|_| format!("{project} is not a git repository"))?;
    git(project_dir, &["check-ref-format", "--branch", branch])
        .map_err(|_| format!("{branch:?} is not a valid branch name"))?;
    let head = git(project_dir, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let base = if head == "HEAD" {
        git(project_dir, &["rev-parse", "HEAD"])?
    } else {
        head
    };
    let dir = worktree_dir(root, &toplevel, branch);
    let dir_str = dir.to_string_lossy().to_string();

    // Reopening an issue reuses its worktree.
    if dir.exists() && git(&dir, &["rev-parse", "--is-inside-work-tree"]).is_ok() {
        return Ok(WorktreeInfo {
            path: dir_str,
            branch: branch.to_string(),
            base,
        });
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let exists = git(
        project_dir,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok();
    if exists {
        git(project_dir, &["worktree", "add", &dir_str, branch])?;
    } else {
        git(
            project_dir,
            &["worktree", "add", "-b", branch, &dir_str, &base],
        )?;
    }
    Ok(WorktreeInfo {
        path: dir_str,
        branch: branch.to_string(),
        base,
    })
}

// Remove a worktree, keeping its branch. A worktree with uncommitted changes
// stays unless `force`.
pub fn remove(project: &str, path: &str, force: bool) -> Result<RemoveOutcome, String> {
    let dir = Path::new(path);
    if !dir.exists() {
        let _ = git(Path::new(project), &["worktree", "prune"]);
        return Ok(RemoveOutcome {
            removed: true,
            dirty: false,
        });
    }
    let dirty = !git(dir, &["status", "--porcelain"])?.is_empty();
    if dirty && !force {
        return Ok(RemoveOutcome {
            removed: false,
            dirty: true,
        });
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path);
    git(Path::new(project), &args)?;
    Ok(RemoveOutcome {
        removed: true,
        dirty,
    })
}

// HOY-359: whether agents can open pull requests: gh installed and signed in.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    pub installed: bool,
    pub authenticated: bool,
    // What to fix, in a sentence, when not ready.
    pub problem: Option<String>,
}

pub fn gh_status() -> GhStatus {
    match Command::new("gh").args(["auth", "status"]).output() {
        Err(_) => GhStatus {
            installed: false,
            authenticated: false,
            problem: Some("Install the GitHub CLI (gh) to let agents open pull requests.".into()),
        },
        Ok(out) if out.status.success() => GhStatus {
            installed: true,
            authenticated: true,
            problem: None,
        },
        Ok(_) => GhStatus {
            installed: true,
            authenticated: false,
            problem: Some("Sign in to the GitHub CLI with gh auth login.".into()),
        },
    }
}

// HOY-379: what a finished run left on its branch.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchStatus {
    // Commits on the branch that its base does not have.
    pub ahead: u32,
    pub dirty: bool,
}

pub fn branch_status(path: &str, base: &str) -> Result<BranchStatus, String> {
    let dir = Path::new(path);
    let ahead = git(dir, &["rev-list", "--count", &format!("{base}..HEAD")])?
        .parse()
        .unwrap_or(0);
    let dirty = !git(dir, &["status", "--porcelain"])?.is_empty();
    Ok(BranchStatus { ahead, dirty })
}

fn pr_url(text: &str) -> Option<String> {
    text.split_whitespace()
        .rev()
        .find(|w| w.starts_with("https://") && w.contains("/pull/"))
        .map(str::to_string)
}

// Push the branch and open a pull request filled from its commits. Returns
// its URL, or the URL of the one already open for the branch.
pub fn open_pull_request(path: &str, branch: &str, base: &str) -> Result<String, String> {
    let dir = Path::new(path);
    git(dir, &["push", "-u", "origin", branch])?;
    let mut args = vec!["pr", "create", "--fill", "--head", branch];
    // A detached base is a commit, which gh cannot target.
    let detached = base.len() == 40 && base.chars().all(|c| c.is_ascii_hexdigit());
    if !detached {
        args.extend(["--base", base]);
    }
    let out = Command::new("gh")
        .current_dir(dir)
        .args(&args)
        .output()
        .map_err(|e| format!("run gh: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        return pr_url(&stdout)
            .ok_or_else(|| format!("gh did not print a pull request URL: {stdout}"));
    }
    pr_url(&stderr)
        .filter(|_| stderr.contains("already exists"))
        .ok_or_else(|| stderr.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(tag: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("hoy-wt-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@t"],
            vec!["config", "user.name", "t"],
        ] {
            git(&repo, &args).unwrap();
        }
        std::fs::write(repo.join("a.txt"), "a").unwrap();
        git(&repo, &["add", "."]).unwrap();
        git(&repo, &["commit", "-q", "-m", "init"]).unwrap();
        (base.join("agent"), repo)
    }

    #[test]
    fn creates_reuses_and_removes_a_worktree_keeping_the_branch() {
        let (root, repo) = repo("cycle");
        let p = repo.to_str().unwrap();
        let wt = create_under(&root, p, "hoy/hoy-1-fix").unwrap();
        assert_eq!(wt.base, "main");
        assert!(Path::new(&wt.path).join("a.txt").exists());
        assert!(wt.path.starts_with(root.to_str().unwrap()));
        assert_eq!(create_under(&root, p, "hoy/hoy-1-fix").unwrap(), wt);

        std::fs::write(Path::new(&wt.path).join("b.txt"), "b").unwrap();
        let kept = remove(p, &wt.path, false).unwrap();
        assert_eq!(
            kept,
            RemoveOutcome {
                removed: false,
                dirty: true
            }
        );
        assert!(Path::new(&wt.path).exists());

        let gone = remove(p, &wt.path, true).unwrap();
        assert!(gone.removed);
        assert!(!Path::new(&wt.path).exists());
        assert!(git(&repo, &["show-ref", "--verify", "refs/heads/hoy/hoy-1-fix"]).is_ok());

        // The branch still exists, so a new worktree checks it out again.
        let again = create_under(&root, p, "hoy/hoy-1-fix").unwrap();
        assert!(Path::new(&again.path).exists());
    }

    #[test]
    fn branch_status_counts_commits_ahead_and_changes() {
        let (root, repo) = repo("status");
        let wt = create_under(&root, repo.to_str().unwrap(), "hoy/hoy-2").unwrap();
        let dir = Path::new(&wt.path);
        assert_eq!(
            branch_status(&wt.path, &wt.base).unwrap(),
            BranchStatus {
                ahead: 0,
                dirty: false
            }
        );
        std::fs::write(dir.join("b.txt"), "b").unwrap();
        assert!(branch_status(&wt.path, &wt.base).unwrap().dirty);
        git(dir, &["add", "."]).unwrap();
        git(dir, &["commit", "-q", "-m", "b"]).unwrap();
        assert_eq!(
            branch_status(&wt.path, &wt.base).unwrap(),
            BranchStatus {
                ahead: 1,
                dirty: false
            }
        );
    }

    #[test]
    fn finds_the_pull_request_url_gh_prints() {
        assert_eq!(
            pr_url("Creating pull request\nhttps://github.com/o/r/pull/12\n").as_deref(),
            Some("https://github.com/o/r/pull/12")
        );
        assert_eq!(
            pr_url("a pull request for branch \"x\" into branch \"main\" already exists:\nhttps://github.com/o/r/pull/7").as_deref(),
            Some("https://github.com/o/r/pull/7")
        );
        assert_eq!(pr_url("no remote"), None);
    }

    #[test]
    fn a_plain_folder_is_not_a_repo() {
        let dir = std::env::temp_dir().join(format!("hoy-wt-plain-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!is_git_repo(dir.to_str().unwrap()));
        assert!(create_under(&dir, dir.to_str().unwrap(), "hoy/x").is_err());
    }

    #[test]
    fn slugs_are_filesystem_safe() {
        assert_eq!(
            slug("hoy/HOY-12 Fix: the thing!"),
            "hoy-hoy-12-fix-the-thing"
        );
    }
}
