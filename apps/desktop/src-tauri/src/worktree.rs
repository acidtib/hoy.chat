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
