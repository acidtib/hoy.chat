// Hoy's own persistence: the projects -> threads tree, stored as workspace.json
// in the branded agent dir (~/.hoy/agent, via pi_config::agent_dir). This is the
// metadata layer. Pi owns the transcripts (SessionManager writes JSONL session
// files under the same dir). Each thread carries the durable sessionFile path so
// a reopened thread can SessionManager.open() its prior conversation.
//
// Read-modify-write is atomic (temp + rename), mirroring pi_config's auth.json
// handling. The live sidecar process id is NOT persisted (it is ephemeral). Only
// sessionFile is durable.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::linear::LinearIssue;
use crate::pi_config::agent_dir;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Workspace {
    #[serde(default)]
    pub projects: Vec<WsProject>,
    // The last project the user worked in, restored so the home launcher can
    // default a new thread to it across restarts. camelCase to match the
    // frontend Workspace shape. Absent in pre-flag files.
    #[serde(rename = "activeProjectId", default)]
    pub active_project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsProject {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub threads: Vec<WsThread>,
    // HOY-346: the Linear team whose open issues feed the Delegate board.
    #[serde(default)]
    pub linear: Option<WsLinearLink>,
    #[serde(default)]
    pub fleet: Option<WsFleet>,
}

// HOY-350: the project's per-agent queues. Array order is queue order; the
// full issue is kept so a queued item can start after a restart.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsFleet {
    #[serde(default)]
    pub queue: Vec<WsQueuedIssue>,
    #[serde(default)]
    pub concurrency: std::collections::BTreeMap<String, u32>,
    // HOY-359: agents push their branch and open a pull request with gh.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub open_pull_requests: bool,
    // HOY-353: Auto triages unassigned issues through the Dispatcher.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub auto: bool,
    // HOY-353: the Dispatcher's cached verdicts, keyed by Linear issue id.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub decisions: std::collections::BTreeMap<String, WsCachedDecision>,
    // HOY-379: per issue id, the Linear comment a handoff chain replies under.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub chain_comments: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch_spend: Option<f64>,
}

// `at` is the issue's updatedAt the decision was made for.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsCachedDecision {
    pub at: Option<String>,
    pub decision: WsDispatchDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nagged_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsDispatchDecision {
    pub ready: bool,
    pub agent: Option<String>,
    pub confidence: f64,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsQueuedIssue {
    pub agent: String,
    pub issue: LinearIssue,
    pub queued_at: u64,
    // HOY-353: the Auto decision that queued it, echoed into the first prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<WsDispatchDecision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<WsHandoff>,
}

// HOY-379: how a run got its issue from the run before it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsHandoff {
    pub from_thread_id: String,
    pub from_agent: String,
    pub reason: String,
    pub by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<String>,
    #[serde(default)]
    pub round: u32,
    #[serde(default)]
    pub hops: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsChainStop {
    pub reason: String,
    pub needs_user: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsNextStep {
    pub agent: String,
    pub reason: String,
    pub by: String,
    #[serde(default)]
    pub round: u32,
}

// One run of a delegated thread, from dispatch to its first stop (HOY-350).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsFleetRun {
    pub started_at: u64,
    #[serde(default)]
    pub ended_at: Option<u64>,
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub estimate: Option<f64>,
    #[serde(default)]
    pub cost: Option<f64>,
    #[serde(default)]
    pub acknowledged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsLinearLink {
    pub team_id: String,
    pub team_key: String,
    pub team_name: String,
    // HOY-374: the Linear workspace (organization) the team lives in. Absent on
    // links saved before multi-workspace support; resolved from the team then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
}

// The Linear issue a delegated thread is working on (HOY-346).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsLinearIssueRef {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsThread {
    pub id: String,
    pub title: String,
    pub updated_at: u64,
    #[serde(default)]
    pub session_file: Option<String>,
    #[serde(default)]
    pub archived: bool,
    // True once the user manually renamed the thread. Pre-flag workspaces
    // default to false.
    #[serde(default)]
    pub renamed: bool,
    // Unsent composer text, restored into the editor on reopen.
    #[serde(default)]
    pub draft: Option<String>,
    // Permission mode (HOY-186). Absent means default. The renderer re-applies
    // it to the thread's sidecar after spawn.
    #[serde(default)]
    pub permission_mode: Option<String>,
    // HOY-231: subagent orchestration. A spawned child thread's parent, so the
    // tree survives restart. Absent for top-level threads and pre-HOY-231 files.
    #[serde(default)]
    pub parent_thread_id: Option<String>,
    #[serde(default)]
    pub spawned_by: Option<SpawnedBy>,
    // Last-selected model (HOY-267): a cached hint so the sidebar can show the
    // thread's provider glyph on load without spawning the session. The session
    // JSONL remains the source of truth. The renderer reconciles this against
    // get_state after the thread is opened. Absent on new/session-less threads
    // and pre-HOY-267 files.
    #[serde(default)]
    pub model: Option<WsModelRef>,
    // Goal Mode (HOY-263): the thread's goal loop state, if any. Absent for
    // threads with no goal and pre-HOY-263 files. On load, the frontend
    // (store.ts initWorkspace) demotes a restored "active" goal to "paused"
    // and resets its counters so it does not auto-run. A "met"/"cleared"
    // goal is dropped rather than restored. Persisted as-is here. The reset
    // is a load-time frontend concern, not a workspace.rs one.
    #[serde(default)]
    pub goal: Option<WsGoal>,
    // HOY-346: a thread delegated from the board runs as this subagent type,
    // working on this issue.
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub linear_issue: Option<WsLinearIssueRef>,
    #[serde(default)]
    pub fleet_run: Option<WsFleetRun>,
    // HOY-359: the pull request a delegated run opened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request: Option<String>,
    // HOY-358: the git worktree a delegated issue runs in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WsWorktree>,
    // HOY-379: Fleet handoff chain state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<WsHandoff>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handed_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain_stop: Option<WsChainStop>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_step: Option<WsNextStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsWorktree {
    pub path: String,
    pub branch: String,
    pub base: String,
    // Archiving took the worktree down; the branch stays.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub removed: bool,
}

// A provider/model identity pair, mirroring the frontend ModelRef. Cached on the
// thread so the sidebar row icon renders before the session is hydrated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsModelRef {
    pub provider: String,
    pub id: String,
}

// Mirror of the frontend ThreadGoal (src/state/goal.ts). Keep the two in sync
// (AGENTS.md): same fields, same camelCase names.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsGoal {
    pub condition: String,
    pub status: String,
    pub turns: u32,
    pub tokens_baseline: u64,
    pub tokens_used: u64,
    pub started_at: u64,
    pub cap_turns: u32,
    #[serde(default)]
    pub evaluator_model: Option<WsModelRef>,
    #[serde(default)]
    pub last_reason: Option<String>,
    // HOY-298 (Goal Mode v2): optional deterministic verify gate. Mirrors the
    // ThreadGoal fields. #[serde(default)] so pre-v2 workspaces still load. Kept
    // in sync with the frontend so a persisted verifyCommand/verifyCwd is not
    // silently dropped on save/load.
    #[serde(default)]
    pub verify_command: Option<String>,
    #[serde(default)]
    pub verify_cwd: Option<String>,
    // HOY-299 (Goal Mode v3): which evaluator the loop uses ("transcript" default
    // when absent, or "auditor" for the independent read-only auditor). Mirrors
    // the ThreadGoal field. #[serde(default)] so pre-v3 workspaces still load.
    // (lastVerifyExit remains intentionally NOT persisted, like lastReason's
    // transient sibling.)
    #[serde(default)]
    pub evaluator_kind: Option<String>,
}

// Which agent spawned this thread and under what role, for child threads
// created via subagent orchestration (HOY-231).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnedBy {
    pub r#type: String,
    pub agent_id: String,
}

fn workspace_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("workspace.json"))
}

fn load_at(path: &Path) -> Result<Workspace, String> {
    match std::fs::read(path) {
        Ok(bytes) if bytes.is_empty() => Ok(Workspace::default()),
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("parse workspace.json: {e}"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Workspace::default()),
        Err(e) => Err(format!("read workspace.json: {e}")),
    }
}

fn save_at(path: &Path, workspace: &Workspace) -> Result<(), String> {
    let dir = path.parent().ok_or("workspace.json path has no parent")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let mut body = serde_json::to_vec_pretty(workspace)
        .map_err(|e| format!("serialize workspace.json: {e}"))?;
    body.push(b'\n');

    let tmp = dir.join(format!("workspace.json.tmp-{}", std::process::id()));
    std::fs::write(&tmp, &body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("replace {}: {e}", path.display())
    })
}

pub fn load() -> Result<Workspace, String> {
    load_at(&workspace_path()?)
}

pub fn save(workspace: &Workspace) -> Result<(), String> {
    save_at(&workspace_path()?, workspace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_path(tag: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!(
                "hoy-ws-test-{}-{}-{}",
                std::process::id(),
                tag,
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ))
            .join("workspace.json")
    }

    fn sample() -> Workspace {
        Workspace {
            active_project_id: Some("p1".into()),
            projects: vec![WsProject {
                id: "p1".into(),
                name: "hoy".into(),
                path: Some("/home/u/code/hoy".into()),
                linear: Some(WsLinearLink {
                    workspace_id: None,
                    workspace_name: None,
                    team_id: "team-1".into(),
                    team_key: "HOY".into(),
                    team_name: "Hoy".into(),
                }),
                fleet: Some(WsFleet {
                    queue: vec![WsQueuedIssue {
                        agent: "Explore".into(),
                        issue: LinearIssue {
                            id: "issue-2".into(),
                            identifier: "HOY-29".into(),
                            title: "queued".into(),
                            description: None,
                            url: "https://linear.app/hoy/issue/HOY-29".into(),
                            priority: 2,
                            priority_label: "High".into(),
                            estimate: Some(3.0),
                            state_name: "Todo".into(),
                            state_type: "unstarted".into(),
                            assignee: None,
                            labels: vec!["Bug".into()],
                            branch_name: None,
                            updated_at: None,
                        },
                        queued_at: 1_717_000_000_500,
                        decision: None,
                        handoff: Some(WsHandoff {
                            from_thread_id: "t1".into(),
                            from_agent: "Coder".into(),
                            reason: "Committed and moved to In Review.".into(),
                            by: "rule".into(),
                            report: None,
                            round: 1,
                            hops: 2,
                            branch: Some("hoy/hoy-28-ticket".into()),
                        }),
                    }],
                    concurrency: [("Explore".to_string(), 2)].into_iter().collect(),
                    open_pull_requests: true,
                    auto: true,
                    decisions: Default::default(),
                    chain_comments: [("issue-2".to_string(), "c1".to_string())]
                        .into_iter()
                        .collect(),
                    dispatch_spend: Some(0.002),
                }),
                threads: vec![WsThread {
                    id: "t1".into(),
                    title: "ticket HOY-28".into(),
                    updated_at: 1_717_000_000_000,
                    session_file: Some("/home/u/.hoy/sessions/abc/s1.jsonl".into()),
                    archived: false,
                    renamed: true,
                    draft: Some("unsent composer text".into()),
                    permission_mode: Some("acceptEdits".into()),
                    parent_thread_id: None,
                    spawned_by: None,
                    model: Some(WsModelRef {
                        provider: "anthropic".into(),
                        id: "claude-opus-4-8".into(),
                    }),
                    goal: Some(WsGoal {
                        condition: "tests pass".into(),
                        status: "active".into(),
                        turns: 3,
                        tokens_baseline: 100,
                        tokens_used: 250,
                        started_at: 1_717_000_000_000,
                        cap_turns: 25,
                        evaluator_model: Some(WsModelRef {
                            provider: "anthropic".into(),
                            id: "claude-haiku".into(),
                        }),
                        last_reason: Some("still working".into()),
                        verify_command: Some("bun test".into()),
                        verify_cwd: None,
                        evaluator_kind: Some("auditor".into()),
                    }),
                    agent: Some("Explore".into()),
                    linear_issue: Some(WsLinearIssueRef {
                        id: "issue-1".into(),
                        identifier: "HOY-28".into(),
                        title: "ticket".into(),
                        url: "https://linear.app/hoy/issue/HOY-28".into(),
                    }),
                    fleet_run: Some(WsFleetRun {
                        started_at: 1_717_000_000_000,
                        ended_at: Some(1_717_000_600_000),
                        outcome: Some("done".into()),
                        estimate: Some(2.0),
                        cost: Some(0.42),
                        acknowledged: false,
                    }),
                    pull_request: None,
                    worktree: Some(WsWorktree {
                        path: "/w/hoy-28".into(),
                        branch: "hoy/hoy-28-ticket".into(),
                        base: "main".into(),
                        removed: false,
                    }),
                    handoff: None,
                    handed_to: Some("Reviewer".into()),
                    chain_stop: Some(WsChainStop {
                        reason: "Two review rounds did not settle it.".into(),
                        needs_user: true,
                    }),
                    next_step: None,
                }],
            }],
        }
    }

    #[test]
    fn linear_fields_round_trip_camel_case() {
        let json = serde_json::to_string(&sample()).unwrap();
        assert!(json.contains(
            "\"linear\":{\"teamId\":\"team-1\",\"teamKey\":\"HOY\",\"teamName\":\"Hoy\"}"
        ));
        assert!(json.contains("\"agent\":\"Explore\""));
        assert!(json.contains("\"linearIssue\":{\"id\":\"issue-1\",\"identifier\":\"HOY-28\""));
        let back: Workspace = serde_json::from_str(&json).unwrap();
        let t = &back.projects[0].threads[0];
        assert_eq!(t.linear_issue.as_ref().unwrap().identifier, "HOY-28");
        assert_eq!(back.projects[0].linear.as_ref().unwrap().team_key, "HOY");
    }

    #[test]
    fn handoff_fields_round_trip_camel_case() {
        let json = serde_json::to_string(&sample()).unwrap();
        assert!(json.contains("\"fromThreadId\":\"t1\""));
        assert!(json.contains("\"chainComments\":{\"issue-2\":\"c1\"}"));
        assert!(json.contains("\"handedTo\":\"Reviewer\""));
        assert!(json.contains("\"needsUser\":true"));
        let back: Workspace = serde_json::from_str(&json).unwrap();
        let q = &back.projects[0].fleet.as_ref().unwrap().queue[0];
        assert_eq!(q.handoff.as_ref().unwrap().round, 1);
    }

    #[test]
    fn fleet_queue_and_runs_round_trip_camel_case() {
        let json = serde_json::to_string(&sample()).unwrap();
        assert!(json.contains("\"queuedAt\":1717000000500"));
        assert!(json.contains("\"concurrency\":{\"Explore\":2}"));
        assert!(
            json.contains("\"fleetRun\":{\"startedAt\":1717000000000,\"endedAt\":1717000600000")
        );
        let back: Workspace = serde_json::from_str(&json).unwrap();
        let fleet = back.projects[0].fleet.as_ref().unwrap();
        assert_eq!(fleet.queue[0].issue.identifier, "HOY-29");
        assert_eq!(fleet.queue[0].issue.labels, vec!["Bug".to_string()]);
        let run = back.projects[0].threads[0].fleet_run.as_ref().unwrap();
        assert_eq!(run.outcome.as_deref(), Some("done"));
        assert_eq!(run.cost, Some(0.42));
    }

    #[test]
    fn missing_file_loads_empty() {
        let path = temp_path("missing");
        assert!(load_at(&path).unwrap().projects.is_empty());
    }

    #[test]
    fn round_trips_projects_and_threads() {
        let path = temp_path("round");
        save_at(&path, &sample()).unwrap();
        let loaded = load_at(&path).unwrap();
        assert_eq!(loaded.projects.len(), 1);
        assert_eq!(loaded.active_project_id.as_deref(), Some("p1"));
        let p = &loaded.projects[0];
        assert_eq!(p.name, "hoy");
        assert_eq!(p.path.as_deref(), Some("/home/u/code/hoy"));
        let t = &p.threads[0];
        assert_eq!(t.title, "ticket HOY-28");
        assert_eq!(t.updated_at, 1_717_000_000_000);
        assert!(t.session_file.is_some());
        assert!(!t.archived);
        assert!(t.renamed);
        assert_eq!(t.draft.as_deref(), Some("unsent composer text"));
        let m = t.model.as_ref().expect("model persists");
        assert_eq!(m.provider, "anthropic");
        assert_eq!(m.id, "claude-opus-4-8");
        let g = t.goal.as_ref().expect("goal persists");
        assert_eq!(g.condition, "tests pass");
        assert_eq!(g.status, "active");
        assert_eq!(g.turns, 3);
        assert_eq!(g.tokens_baseline, 100);
        assert_eq!(g.tokens_used, 250);
        assert_eq!(g.started_at, 1_717_000_000_000);
        assert_eq!(g.cap_turns, 25);
        let em = g
            .evaluator_model
            .as_ref()
            .expect("evaluator_model persists");
        assert_eq!(em.provider, "anthropic");
        assert_eq!(em.id, "claude-haiku");
        assert_eq!(g.last_reason.as_deref(), Some("still working"));
        assert_eq!(g.verify_command.as_deref(), Some("bun test"));
        assert_eq!(g.verify_cwd, None);
        assert_eq!(g.evaluator_kind.as_deref(), Some("auditor"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn goal_serializes_camel_case_and_omits_when_absent() {
        let path = temp_path("goal");
        save_at(&path, &sample()).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"goal\""));
        assert!(raw.contains("\"tokensBaseline\": 100"));
        assert!(raw.contains("\"tokensUsed\": 250"));
        assert!(raw.contains("\"capTurns\": 25"));
        assert!(raw.contains("\"lastReason\": \"still working\""));
        assert!(!raw.contains("tokens_baseline"));

        // Pre-HOY-263 files (no goal key) load with None rather than failing.
        std::fs::write(
            &path,
            r#"{"projects":[{"id":"p1","name":"hoy","threads":[{"id":"t1","title":"T","updatedAt":1}]}]}"#,
        )
        .unwrap();
        let loaded = load_at(&path).unwrap();
        assert!(loaded.projects[0].threads[0].goal.is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn model_serializes_camel_case_and_omits_when_absent() {
        let path = temp_path("model");
        save_at(&path, &sample()).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"model\""));
        assert!(raw.contains("\"provider\": \"anthropic\""));
        assert!(raw.contains("\"id\": \"claude-opus-4-8\""));

        // Pre-HOY-267 files (no model key) load with None rather than failing.
        std::fs::write(
            &path,
            r#"{"projects":[{"id":"p1","name":"hoy","threads":[{"id":"t1","title":"T","updatedAt":1}]}]}"#,
        )
        .unwrap();
        let loaded = load_at(&path).unwrap();
        assert!(loaded.projects[0].threads[0].model.is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn save_replaces_existing_atomically() {
        let path = temp_path("replace");
        save_at(&path, &sample()).unwrap();
        let mut next = Workspace::default();
        next.projects.push(WsProject {
            id: "p2".into(),
            name: "jiji".into(),
            path: None,
            threads: vec![],
            linear: None,
            fleet: None,
        });
        save_at(&path, &next).unwrap();
        let loaded = load_at(&path).unwrap();
        assert_eq!(loaded.projects.len(), 1);
        assert_eq!(loaded.projects[0].name, "jiji");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn pre_draft_files_load_with_none() {
        let path = temp_path("nodraft");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"projects":[{"id":"p1","name":"hoy","threads":[{"id":"t1","title":"T","updatedAt":1}]}]}"#,
        )
        .unwrap();
        let loaded = load_at(&path).unwrap();
        assert!(loaded.projects[0].threads[0].draft.is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn camelcase_keys_match_frontend_shape() {
        let path = temp_path("camel");
        save_at(&path, &sample()).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"updatedAt\""));
        assert!(raw.contains("\"sessionFile\""));
        assert!(raw.contains("\"activeProjectId\""));
        assert!(!raw.contains("updated_at"));
        assert!(!raw.contains("active_project_id"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn child_thread_fields_round_trip_camel_case() {
        let ws = Workspace {
            projects: vec![WsProject {
                id: "p1".into(),
                name: "P".into(),
                path: None,
                linear: None,
                fleet: None,
                threads: vec![WsThread {
                    id: "t2".into(),
                    title: "child".into(),
                    updated_at: 1,
                    session_file: Some("f".into()),
                    archived: false,
                    renamed: false,
                    draft: None,
                    permission_mode: None,
                    parent_thread_id: Some("t1".into()),
                    spawned_by: Some(SpawnedBy {
                        r#type: "Explore".into(),
                        agent_id: "a1".into(),
                    }),
                    model: None,
                    goal: None,
                    agent: None,
                    linear_issue: None,
                    fleet_run: None,
                    pull_request: None,
                    worktree: None,
                    handoff: None,
                    handed_to: None,
                    chain_stop: None,
                    next_step: None,
                }],
            }],
            active_project_id: None,
        };
        let json = serde_json::to_string(&ws).unwrap();
        assert!(json.contains("\"parentThreadId\":\"t1\""));
        assert!(json.contains("\"spawnedBy\""));
        assert!(json.contains("\"type\":\"Explore\""));
        assert!(json.contains("\"agentId\":\"a1\""));
        let back: Workspace = serde_json::from_str(&json).unwrap();
        assert_eq!(
            back.projects[0].threads[0].parent_thread_id.as_deref(),
            Some("t1")
        );
    }
}
