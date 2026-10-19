// Linear integration (HOY-346): credentials and the GraphQL calls the Delegate
// board needs. Credentials (OAuth tokens or a personal API key) live under
// "linear" in integrations.json in the agent dir (0600, atomic write) and never
// reach the renderer; only LinearStatus does.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::linear_oauth;
use crate::pi_config::agent_dir;

const ENDPOINT: &str = "https://api.linear.app/graphql";

// Refresh this long before expiry so an in-flight call never carries a dead token.
const REFRESH_MARGIN_MS: u64 = 60_000;

static FILE_LOCK: Mutex<()> = Mutex::new(());
// Serializes token refresh: Linear rotates refresh tokens on use.
static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    oauth: Option<OAuthTokens>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OAuthTokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    // Epoch ms.
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinearStatus {
    pub connected: bool,
    // "oauth" | "apiKey" while connected.
    pub method: Option<String>,
    pub viewer_name: Option<String>,
    pub organization: Option<String>,
    // A stored credential that Linear rejected or could not be reached with.
    pub error: Option<String>,
    // This build carries a Linear OAuth client id.
    pub oauth_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinearTeam {
    pub id: String,
    pub key: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinearIssue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub url: String,
    // 0 none, 1 urgent, 2 high, 3 medium, 4 low.
    pub priority: u8,
    pub priority_label: String,
    pub estimate: Option<f64>,
    pub state_name: String,
    pub state_type: String,
    pub assignee: Option<String>,
    pub labels: Vec<String>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// One file for every integration's credentials, keyed by integration name.
const SECTION: &str = "linear";

fn key_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("integrations.json"))
}

fn read_file_at(path: &Path) -> Result<Map<String, Value>, String> {
    match std::fs::read(path) {
        Ok(bytes) if bytes.is_empty() => Ok(Map::new()),
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(map)) => Ok(map),
            Ok(_) => Err("integrations.json is not a JSON object".to_string()),
            Err(e) => Err(format!("parse integrations.json: {e}")),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(format!("read integrations.json: {e}")),
    }
}

fn read_at(path: &Path) -> Result<Credentials, String> {
    let Some(section) = read_file_at(path)?.remove(SECTION) else {
        return Ok(Credentials::default());
    };
    let mut creds: Credentials = serde_json::from_value(section)
        .map_err(|e| format!("parse integrations.json {SECTION}: {e}"))?;
    creds.api_key = creds.api_key.filter(|k| !k.trim().is_empty());
    Ok(creds)
}

// Read-modify-write of the Linear section only; other integrations are kept.
// None removes the section.
fn write_at(path: &Path, creds: Option<&Credentials>) -> Result<(), String> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = read_file_at(path)?;
    match creds {
        Some(c) => {
            let value =
                serde_json::to_value(c).map_err(|e| format!("serialize integrations.json: {e}"))?;
            map.insert(SECTION.to_string(), value);
        }
        None => {
            map.remove(SECTION);
        }
    }

    let dir = path
        .parent()
        .ok_or("integrations.json path has no parent")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let mut body = serde_json::to_vec_pretty(&Value::Object(map))
        .map_err(|e| format!("serialize integrations.json: {e}"))?;
    body.push(b'\n');

    let tmp = dir.join(format!("integrations.json.tmp-{}", std::process::id()));
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|e| format!("open {}: {e}", tmp.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        f.write_all(&body)
            .and_then(|_| f.flush())
            .and_then(|_| f.sync_all())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("replace {}: {e}", path.display())
    })
}

fn fresh(tokens: &OAuthTokens) -> bool {
    tokens.expires_at > now_ms() + REFRESH_MARGIN_MS
}

// The Authorization header value for the stored credential, refreshing an
// expiring OAuth token first. OAuth wins when both are stored.
async fn auth_header() -> Result<String, String> {
    let path = key_path()?;
    let creds = read_at(&path)?;
    if let Some(tokens) = &creds.oauth {
        if fresh(tokens) {
            return Ok(format!("Bearer {}", tokens.access_token));
        }
        let _guard = REFRESH_LOCK.lock().await;
        // Another call may have refreshed while this one waited.
        let creds = read_at(&path)?;
        let tokens = creds.oauth.clone().ok_or("Linear is not connected")?;
        if fresh(&tokens) {
            return Ok(format!("Bearer {}", tokens.access_token));
        }
        let refresh = tokens
            .refresh_token
            .ok_or("Your Linear session expired. Sign in again.")?;
        let renewed = linear_oauth::refresh(&refresh).await?;
        let header = format!("Bearer {}", renewed.access_token);
        write_at(
            &path,
            Some(&Credentials {
                oauth: Some(renewed),
                ..creds
            }),
        )?;
        return Ok(header);
    }
    // Personal API keys go in the header as-is, without a Bearer prefix.
    creds
        .api_key
        .ok_or_else(|| "Linear is not connected".to_string())
}

pub fn http_client() -> Result<reqwest::Client, String> {
    // reqwest is built with rustls-no-provider (via the updater); install ring
    // before the first client. A second install is a harmless Err.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

async fn graphql(auth: &str, query: &str, variables: Value) -> Result<Value, String> {
    let response = http_client()?
        .post(ENDPOINT)
        .header("Authorization", auth)
        .json(&json!({ "query": query, "variables": variables }))
        .send()
        .await
        .map_err(|e| format!("Could not reach Linear: {e}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("Linear returned {status}: {e}"))?;
    data_of(body)
}

// Linear reports query and auth failures in `errors`, often with a 400.
fn data_of(body: Value) -> Result<Value, String> {
    if let Some(err) = body
        .get("errors")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
    {
        let message = err
            .pointer("/extensions/userPresentableMessage")
            .and_then(Value::as_str)
            .or_else(|| err.get("message").and_then(Value::as_str))
            .unwrap_or("Linear request failed");
        return Err(message.to_string());
    }
    body.get("data")
        .cloned()
        .ok_or_else(|| "Linear response missing data".to_string())
}

const VIEWER_QUERY: &str = "query { viewer { name } organization { name } }";

fn disconnected() -> LinearStatus {
    LinearStatus {
        connected: false,
        method: None,
        viewer_name: None,
        organization: None,
        error: None,
        oauth_available: linear_oauth::available(),
    }
}

fn method_of(creds: &Credentials) -> Option<String> {
    if creds.oauth.is_some() {
        Some("oauth".into())
    } else if creds.api_key.is_some() {
        Some("apiKey".into())
    } else {
        None
    }
}

fn parse_status(data: &Value, method: Option<String>) -> LinearStatus {
    LinearStatus {
        connected: true,
        method,
        viewer_name: data
            .pointer("/viewer/name")
            .and_then(Value::as_str)
            .map(str::to_string),
        organization: data
            .pointer("/organization/name")
            .and_then(Value::as_str)
            .map(str::to_string),
        error: None,
        oauth_available: linear_oauth::available(),
    }
}

pub async fn status() -> Result<LinearStatus, String> {
    let creds = read_at(&key_path()?)?;
    let Some(method) = method_of(&creds) else {
        return Ok(disconnected());
    };
    let result = match auth_header().await {
        Ok(auth) => graphql(&auth, VIEWER_QUERY, json!({})).await,
        Err(e) => Err(e),
    };
    Ok(match result {
        Ok(data) => parse_status(&data, Some(method)),
        Err(e) => LinearStatus {
            connected: true,
            method: Some(method),
            error: Some(e),
            ..disconnected()
        },
    })
}

pub async fn connect(api_key: &str) -> Result<LinearStatus, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("API key is empty".to_string());
    }
    let data = graphql(key, VIEWER_QUERY, json!({})).await?;
    write_at(
        &key_path()?,
        Some(&Credentials {
            api_key: Some(key.to_string()),
            oauth: None,
        }),
    )?;
    Ok(parse_status(&data, Some("apiKey".into())))
}

pub async fn connect_oauth(app: &tauri::AppHandle) -> Result<LinearStatus, String> {
    let tokens = linear_oauth::login(app).await?;
    let data = graphql(
        &format!("Bearer {}", tokens.access_token),
        VIEWER_QUERY,
        json!({}),
    )
    .await?;
    write_at(
        &key_path()?,
        Some(&Credentials {
            api_key: None,
            oauth: Some(tokens),
        }),
    )?;
    Ok(parse_status(&data, Some("oauth".into())))
}

pub async fn disconnect() -> Result<(), String> {
    let path = key_path()?;
    if let Ok(Credentials {
        oauth: Some(tokens),
        ..
    }) = read_at(&path)
    {
        // Best effort: the local token is dropped either way.
        let _ = linear_oauth::revoke(&tokens.access_token).await;
    }
    write_at(&path, None)
}

const TEAMS_QUERY: &str = "query { teams(first: 100) { nodes { id key name } } }";

fn parse_teams(data: &Value) -> Result<Vec<LinearTeam>, String> {
    let nodes = data
        .pointer("/teams/nodes")
        .cloned()
        .ok_or("Linear teams response missing nodes")?;
    let mut teams: Vec<LinearTeam> =
        serde_json::from_value(nodes).map_err(|e| format!("decode teams: {e}"))?;
    teams.sort_by_key(|t| t.name.to_lowercase());
    Ok(teams)
}

pub async fn teams() -> Result<Vec<LinearTeam>, String> {
    let data = graphql(&auth_header().await?, TEAMS_QUERY, json!({})).await?;
    parse_teams(&data)
}

// Open work only: backlog and unstarted (Todo) states.
const ISSUES_QUERY: &str = r#"query TeamIssues($teamId: ID!) {
  issues(
    first: 100
    orderBy: updatedAt
    filter: { team: { id: { eq: $teamId } }, state: { type: { in: ["backlog", "unstarted"] } } }
  ) {
    nodes {
      id identifier title description url priority priorityLabel estimate
      state { name type }
      assignee { name }
      labels { nodes { name } }
    }
  }
}"#;

fn parse_issues(data: &Value) -> Result<Vec<LinearIssue>, String> {
    let nodes = data
        .pointer("/issues/nodes")
        .and_then(Value::as_array)
        .ok_or("Linear issues response missing nodes")?;
    let str_at = |n: &Value, p: &str| n.pointer(p).and_then(Value::as_str).map(str::to_string);
    let mut issues = Vec::with_capacity(nodes.len());
    for n in nodes {
        let (Some(id), Some(identifier), Some(title), Some(url)) = (
            str_at(n, "/id"),
            str_at(n, "/identifier"),
            str_at(n, "/title"),
            str_at(n, "/url"),
        ) else {
            continue;
        };
        issues.push(LinearIssue {
            id,
            identifier,
            title,
            description: str_at(n, "/description").filter(|d| !d.trim().is_empty()),
            url,
            priority: n
                .get("priority")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(4) as u8,
            priority_label: str_at(n, "/priorityLabel").unwrap_or_default(),
            estimate: n.get("estimate").and_then(Value::as_f64),
            state_name: str_at(n, "/state/name").unwrap_or_default(),
            state_type: str_at(n, "/state/type").unwrap_or_default(),
            assignee: str_at(n, "/assignee/name"),
            labels: n
                .pointer("/labels/nodes")
                .and_then(Value::as_array)
                .map(|ls| {
                    ls.iter()
                        .filter_map(|l| l.get("name").and_then(Value::as_str).map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
        });
    }
    Ok(issues)
}

pub async fn issues(team_id: &str) -> Result<Vec<LinearIssue>, String> {
    let data = graphql(
        &auth_header().await?,
        ISSUES_QUERY,
        json!({ "teamId": team_id }),
    )
    .await?;
    parse_issues(&data)
}

// True when credentials are stored. Read at sidecar spawn to decide whether
// the session gets the Linear agent tools.
pub fn is_connected() -> bool {
    key_path()
        .and_then(|p| read_at(&p))
        .map(|c| method_of(&c).is_some())
        .unwrap_or(false)
}

// Agent-facing Linear actions (HOY-346 write back). The sidecar's Linear tools
// send these as `@hoy/linear:` input requests; Rust runs them with the stored
// credential and answers with a JSON string the tool hands to the model.

const ISSUE_DETAIL_QUERY: &str = r#"query Issue($id: String!) {
  issue(id: $id) {
    id identifier title url description priorityLabel
    state { id name type }
    assignee { name }
    team { id key name states { nodes { id name type position } } }
    comments(first: 20) { nodes { body createdAt user { name } } }
  }
}"#;

#[derive(Debug, Clone, PartialEq)]
struct WorkflowState {
    id: String,
    name: String,
    kind: String,
    position: f64,
}

fn parse_states(issue: &Value) -> Vec<WorkflowState> {
    issue
        .pointer("/team/states/nodes")
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|n| {
                    Some(WorkflowState {
                        id: n.get("id")?.as_str()?.to_string(),
                        name: n.get("name")?.as_str()?.to_string(),
                        kind: n.get("type")?.as_str()?.to_string(),
                        position: n.get("position").and_then(Value::as_f64).unwrap_or(0.0),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

// A state name ("In Review") wins; otherwise a workflow type or a common alias
// picks that type's first state ("done" -> the first completed state).
fn resolve_state<'a>(states: &'a [WorkflowState], wanted: &str) -> Option<&'a WorkflowState> {
    let w = wanted.trim().to_lowercase();
    if let Some(s) = states.iter().find(|s| s.name.to_lowercase() == w) {
        return Some(s);
    }
    let kind = match w.as_str() {
        "done" | "complete" | "completed" | "closed" | "close" | "finished" => "completed",
        "in progress" | "in_progress" | "started" | "start" | "doing" => "started",
        "todo" | "to do" | "unstarted" => "unstarted",
        "canceled" | "cancelled" | "cancel" | "wontfix" | "won't fix" => "canceled",
        "backlog" => "backlog",
        "triage" => "triage",
        _ => return None,
    };
    states
        .iter()
        .filter(|s| s.kind == kind)
        .min_by(|a, b| a.position.total_cmp(&b.position))
}

async fn fetch_issue(auth: &str, id: &str) -> Result<Value, String> {
    let data = graphql(auth, ISSUE_DETAIL_QUERY, json!({ "id": id })).await?;
    data.get("issue")
        .filter(|v| !v.is_null())
        .cloned()
        .ok_or_else(|| format!("Linear issue {id} not found"))
}

fn issue_summary(issue: &Value) -> Value {
    let comments: Vec<Value> = issue
        .pointer("/comments/nodes")
        .and_then(Value::as_array)
        .map(|cs| {
            cs.iter()
                .map(|c| {
                    json!({
                        "author": c.pointer("/user/name"),
                        "createdAt": c.get("createdAt"),
                        "body": c.get("body"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let mut states = parse_states(issue);
    states.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.position.total_cmp(&b.position)));
    json!({
        "identifier": issue.get("identifier"),
        "title": issue.get("title"),
        "url": issue.get("url"),
        "state": issue.pointer("/state/name"),
        "priority": issue.get("priorityLabel"),
        "assignee": issue.pointer("/assignee/name"),
        "team": issue.pointer("/team/key"),
        "description": issue.get("description"),
        "comments": comments,
        "availableStates": states
            .iter()
            .map(|s| format!("{} ({})", s.name, s.kind))
            .collect::<Vec<_>>(),
    })
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn required<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    str_arg(args, key).ok_or_else(|| format!("`{key}` is required"))
}

async fn set_state_on(auth: &str, issue: &Value, wanted: &str) -> Result<Value, String> {
    let states = parse_states(issue);
    let state = resolve_state(&states, wanted).ok_or_else(|| {
        format!(
            "No workflow state matches \"{wanted}\". Available: {}",
            states
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    })?;
    let id = issue.get("id").and_then(Value::as_str).unwrap_or_default();
    graphql(
        auth,
        "mutation SetState($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }",
        json!({ "id": id, "stateId": state.id }),
    )
    .await?;
    Ok(json!({
        "identifier": issue.get("identifier"),
        "state": state.name,
        "from": issue.pointer("/state/name"),
    }))
}

// How a new issue relates to the source issue, read from the source's side, as
// Linear relation input (issueId, relatedIssueId, type). Linear's "blocks"
// means issueId blocks relatedIssueId.
fn relation_input<'a>(
    relation: &str,
    source: &'a str,
    created: &'a str,
) -> Result<Option<(&'a str, &'a str, &'static str)>, String> {
    match relation {
        "" | "none" | "sub_issue" => Ok(None),
        "follow_up" | "related" => Ok(Some((source, created, "related"))),
        // The source blocks the new issue.
        "blocks" => Ok(Some((source, created, "blocks"))),
        // The source is blocked by the new issue.
        "blocked_by" => Ok(Some((created, source, "blocks"))),
        other => Err(format!(
            "Unknown relation \"{other}\". Use follow_up, sub_issue, blocks, blocked_by, or none."
        )),
    }
}

async fn create_issue(auth: &str, args: &Value) -> Result<Value, String> {
    let title = required(args, "title")?;
    let relation = str_arg(args, "relation").unwrap_or("follow_up");
    let source = match str_arg(args, "issue") {
        Some(id) => Some(fetch_issue(auth, id).await?),
        None => None,
    };
    let team_id = match (&source, str_arg(args, "team")) {
        (_, Some(key)) => {
            let data = graphql(
                auth,
                "query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }",
                json!({ "key": key }),
            )
            .await?;
            data.pointer("/teams/nodes/0/id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| format!("No Linear team with key {key}"))?
        }
        (Some(src), None) => src
            .pointer("/team/id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        (None, None) => return Err("Pass `issue` (the source issue) or `team` (a team key)".into()),
    };
    let mut input = json!({ "teamId": team_id, "title": title });
    if let Some(d) = str_arg(args, "description") {
        input["description"] = json!(d);
    }
    let source_id = source
        .as_ref()
        .and_then(|s| s.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if relation == "sub_issue" {
        if source_id.is_empty() {
            return Err("A sub_issue needs `issue` (the parent)".into());
        }
        input["parentId"] = json!(source_id);
    }
    let data = graphql(
        auth,
        "mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier title url } } }",
        json!({ "input": input }),
    )
    .await?;
    let created = data
        .pointer("/issueCreate/issue")
        .cloned()
        .ok_or("Linear did not return the created issue")?;
    let created_id = created
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !source_id.is_empty() {
        if let Some((issue_id, related_id, kind)) =
            relation_input(relation, &source_id, created_id)?
        {
            graphql(
                auth,
                "mutation Relate($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }",
                json!({ "input": { "issueId": issue_id, "relatedIssueId": related_id, "type": kind } }),
            )
            .await?;
        }
    }
    Ok(json!({
        "identifier": created.get("identifier"),
        "title": created.get("title"),
        "url": created.get("url"),
        "relation": relation,
        "source": source.as_ref().and_then(|s| s.get("identifier")),
    }))
}

pub async fn action(payload: &Value) -> Result<Value, String> {
    let auth = auth_header().await?;
    let action = required(payload, "action")?;
    match action {
        "get" => Ok(issue_summary(
            &fetch_issue(&auth, required(payload, "issue")?).await?,
        )),
        "comment" => {
            let issue = fetch_issue(&auth, required(payload, "issue")?).await?;
            let body = required(payload, "body")?;
            let data = graphql(
                &auth,
                "mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { comment { url } } }",
                json!({ "input": { "issueId": issue.get("id"), "body": body } }),
            )
            .await?;
            Ok(json!({
                "identifier": issue.get("identifier"),
                "comment": data.pointer("/commentCreate/comment/url"),
            }))
        }
        "set_state" => {
            let issue = fetch_issue(&auth, required(payload, "issue")?).await?;
            set_state_on(&auth, &issue, required(payload, "state")?).await
        }
        "create" => create_issue(&auth, payload).await,
        other => Err(format!("Unknown Linear action \"{other}\"")),
    }
}

// The wire answer for an `@hoy/linear:` request: always a JSON string, so the
// sidecar tool can tell success from a Linear error.
pub async fn answer(payload: &str) -> String {
    let result = match serde_json::from_str::<Value>(payload) {
        Ok(p) => action(&p).await,
        Err(e) => Err(format!("bad Linear request: {e}")),
    };
    match result {
        Ok(v) => json!({ "ok": true, "result": v }).to_string(),
        Err(e) => json!({ "ok": false, "error": e }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir()
            .join(format!("hoy-linear-{tag}-{}-{n}", std::process::id()))
            .join("integrations.json")
    }

    fn api_key(k: &str) -> Credentials {
        Credentials {
            api_key: Some(k.into()),
            oauth: None,
        }
    }

    #[test]
    fn credentials_round_trip_and_missing_reads_empty() {
        let path = temp_path("roundtrip");
        assert_eq!(read_at(&path).unwrap(), Credentials::default());
        write_at(&path, Some(&api_key("lin_api_abc"))).unwrap();
        assert_eq!(read_at(&path).unwrap(), api_key("lin_api_abc"));
        let raw: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(raw, json!({ "linear": { "apiKey": "lin_api_abc" } }));

        let oauth = Credentials {
            api_key: None,
            oauth: Some(OAuthTokens {
                access_token: "at".into(),
                refresh_token: Some("rt".into()),
                expires_at: 42,
            }),
        };
        write_at(&path, Some(&oauth)).unwrap();
        let raw: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            raw,
            json!({ "linear": { "oauth": { "accessToken": "at", "refreshToken": "rt", "expiresAt": 42 } } })
        );
        assert_eq!(
            method_of(&read_at(&path).unwrap()).as_deref(),
            Some("oauth")
        );
    }

    #[cfg(unix)]
    #[test]
    fn credentials_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_path("mode");
        write_at(&path, Some(&api_key("lin_api_abc"))).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn blank_key_reads_as_disconnected() {
        let path = temp_path("blank");
        write_at(&path, Some(&api_key("  "))).unwrap();
        assert_eq!(method_of(&read_at(&path).unwrap()), None);
    }

    #[test]
    fn writes_keep_other_integrations_and_disconnect_drops_only_linear() {
        let path = temp_path("shared");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{ "github": { "token": "gh" } }"#).unwrap();
        write_at(&path, Some(&api_key("lin_api_abc"))).unwrap();
        let raw: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(raw["github"], json!({ "token": "gh" }));
        assert_eq!(raw["linear"], json!({ "apiKey": "lin_api_abc" }));
        write_at(&path, None).unwrap();
        let raw: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(raw, json!({ "github": { "token": "gh" } }));
    }

    fn states() -> Vec<WorkflowState> {
        let st = |id: &str, name: &str, kind: &str, position: f64| WorkflowState {
            id: id.into(),
            name: name.into(),
            kind: kind.into(),
            position,
        };
        vec![
            st("1", "Backlog", "backlog", 0.0),
            st("2", "Todo", "unstarted", 1.0),
            st("4", "In Review", "started", 3.0),
            st("3", "In Progress", "started", 2.0),
            st("5", "Done", "completed", 4.0),
            st("6", "Canceled", "canceled", 5.0),
        ]
    }

    #[test]
    fn state_names_win_then_types_pick_the_first_state() {
        let s = states();
        let id = |w: &str| resolve_state(&s, w).map(|x| x.id.clone());
        assert_eq!(id("in review").as_deref(), Some("4"));
        assert_eq!(id("started").as_deref(), Some("3"));
        assert_eq!(id("in progress").as_deref(), Some("3"));
        assert_eq!(id("done").as_deref(), Some("5"));
        assert_eq!(id("close").as_deref(), Some("5"));
        assert_eq!(id("cancelled").as_deref(), Some("6"));
        assert_eq!(id("todo").as_deref(), Some("2"));
        assert_eq!(id("shipped"), None);
    }

    #[test]
    fn parses_team_states_from_an_issue() {
        let issue = json!({ "team": { "states": { "nodes": [
            { "id": "a", "name": "Todo", "type": "unstarted", "position": 1 },
            { "id": "b", "name": "Broken" }
        ] } } });
        let s = parse_states(&issue);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].kind, "unstarted");
    }

    #[test]
    fn relations_point_the_right_way() {
        assert_eq!(
            relation_input("follow_up", "src", "new").unwrap(),
            Some(("src", "new", "related"))
        );
        // Linear: issueId blocks relatedIssueId.
        assert_eq!(
            relation_input("blocks", "src", "new").unwrap(),
            Some(("src", "new", "blocks"))
        );
        assert_eq!(
            relation_input("blocked_by", "src", "new").unwrap(),
            Some(("new", "src", "blocks"))
        );
        assert_eq!(relation_input("sub_issue", "src", "new").unwrap(), None);
        assert!(relation_input("duplicates", "src", "new").is_err());
    }

    #[test]
    fn issue_summary_lists_comments_and_states() {
        let issue = json!({
            "identifier": "HOY-1", "title": "t", "url": "u", "description": "d",
            "state": { "name": "Todo" },
            "team": { "key": "HOY", "states": { "nodes": [
                { "id": "a", "name": "Todo", "type": "unstarted", "position": 1 }
            ] } },
            "comments": { "nodes": [ { "body": "hi", "createdAt": "x", "user": { "name": "Ada" } } ] }
        });
        let s = issue_summary(&issue);
        assert_eq!(s["state"], "Todo");
        assert_eq!(s["comments"][0]["author"], "Ada");
        assert_eq!(s["availableStates"][0], "Todo (unstarted)");
    }

    #[test]
    fn tokens_count_as_fresh_until_the_refresh_margin() {
        let at = |expires_at| OAuthTokens {
            access_token: "a".into(),
            refresh_token: None,
            expires_at,
        };
        assert!(fresh(&at(now_ms() + 10 * 60_000)));
        assert!(!fresh(&at(now_ms() + 30_000)));
        assert!(!fresh(&at(0)));
    }

    #[test]
    fn errors_surface_the_user_presentable_message() {
        let body = json!({
            "errors": [{
                "message": "Authentication required, not authenticated",
                "extensions": { "userPresentableMessage": "Invalid API key" }
            }]
        });
        assert_eq!(data_of(body).unwrap_err(), "Invalid API key");
        let body = json!({ "errors": [{ "message": "boom" }] });
        assert_eq!(data_of(body).unwrap_err(), "boom");
    }

    #[test]
    fn parses_viewer_and_org() {
        let data = json!({ "viewer": { "name": "Ada" }, "organization": { "name": "Hoy" } });
        let status = parse_status(&data, Some("apiKey".into()));
        assert!(status.connected);
        assert_eq!(status.viewer_name.as_deref(), Some("Ada"));
        assert_eq!(status.organization.as_deref(), Some("Hoy"));
    }

    #[test]
    fn parses_teams_sorted_by_name() {
        let data = json!({ "teams": { "nodes": [
            { "id": "2", "key": "WEB", "name": "web" },
            { "id": "1", "key": "HOY", "name": "Hoy" }
        ] } });
        let teams = parse_teams(&data).unwrap();
        assert_eq!(
            teams.iter().map(|t| t.key.as_str()).collect::<Vec<_>>(),
            ["HOY", "WEB"]
        );
    }

    #[test]
    fn parses_issues_and_skips_malformed_nodes() {
        let data = json!({ "issues": { "nodes": [
            {
                "id": "u1", "identifier": "HOY-312", "title": "Fix flaky checkout test",
                "description": "", "url": "https://linear.app/x/issue/HOY-312",
                "priority": 2, "priorityLabel": "High", "estimate": 3,
                "state": { "name": "Todo", "type": "unstarted" },
                "assignee": null,
                "labels": { "nodes": [{ "name": "Bug" }] }
            },
            { "id": "u2", "title": "missing identifier" }
        ] } });
        let issues = parse_issues(&data).unwrap();
        assert_eq!(issues.len(), 1);
        let i = &issues[0];
        assert_eq!(i.identifier, "HOY-312");
        assert_eq!(i.description, None);
        assert_eq!(i.priority, 2);
        assert_eq!(i.estimate, Some(3.0));
        assert_eq!(i.state_type, "unstarted");
        assert_eq!(i.assignee, None);
        assert_eq!(i.labels, ["Bug"]);
    }
}
