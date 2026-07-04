// Local usage stats (HOY-262). Reads pi's session transcripts under
// <agent_dir>/sessions/<sessionId>/*.jsonl and folds assistant messages into
// per-day buckets keyed by the user's LOCAL day. Pure disk read: no sidecar,
// no network. The frontend derives ranges/streaks/peak-hour from this report.

use std::collections::BTreeMap;
use std::path::Path;

use chrono::{DateTime, Local, Timelike};
use serde::Serialize;
use serde_json::Value;

use crate::pi_config::agent_dir;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBreakdown {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayBucket {
    pub date: String,
    pub tokens: TokenBreakdown,
    pub cost: f64,
    pub messages: u64,
    // Sessions started on this local day, so a range-scoped session count is a
    // sum over the days in range rather than the all-time meta.session_count.
    pub sessions: u64,
    pub by_model: BTreeMap<String, u64>,
    pub by_hour: [u64; 24],
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageMeta {
    pub session_count: u64,
    pub total_messages: u64,
    pub first_day: Option<String>,
    pub last_day: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub days: Vec<DayBucket>,
    pub meta: UsageMeta,
}

// Per-day accumulator, folded into a DayBucket at the end.
#[derive(Default)]
struct DayAcc {
    tokens: TokenBreakdown,
    cost: f64,
    messages: u64,
    sessions: u64,
    by_model: BTreeMap<String, u64>,
    by_hour: [u64; 24],
}

// Entry point: read the branded agent dir's sessions/ tree. Any resolution
// failure yields an empty report rather than erroring the UI.
pub fn compute_usage() -> UsageReport {
    match agent_dir() {
        Ok(dir) => compute_usage_from(&dir.join("sessions")),
        Err(_) => UsageReport::default(),
    }
}

pub fn compute_usage_from(sessions_dir: &Path) -> UsageReport {
    let mut acc: BTreeMap<String, DayAcc> = BTreeMap::new();
    let mut session_count = 0u64;
    let mut total_messages = 0u64;

    let subdirs = match std::fs::read_dir(sessions_dir) {
        Ok(r) => r,
        Err(_) => return UsageReport::default(),
    };
    for sub in subdirs.flatten() {
        let sub_path = sub.path();
        if !sub_path.is_dir() {
            continue;
        }
        let files = match std::fs::read_dir(&sub_path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for f in files.flatten() {
            let fp = f.path();
            if fp.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&fp) else {
                continue;
            };
            let (msgs, sessions) = fold_file(&content, &mut acc);
            total_messages += msgs;
            session_count += sessions;
        }
    }
    finalize(acc, session_count, total_messages)
}

// Returns (counted messages, session records) for this file.
fn fold_file(content: &str, acc: &mut BTreeMap<String, DayAcc>) -> (u64, u64) {
    let mut messages = 0u64;
    let mut sessions = 0u64;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match v.get("type").and_then(Value::as_str) {
            Some("session") if fold_session(&v, acc) => sessions += 1,
            Some("message") if fold_message(&v, acc) => messages += 1,
            _ => {}
        }
    }
    (messages, sessions)
}

// Bucket a session record onto its local start day. Returns true iff it had a
// parseable timestamp and was counted.
fn fold_session(v: &Value, acc: &mut BTreeMap<String, DayAcc>) -> bool {
    let Some(ts) = v.get("timestamp").and_then(Value::as_str) else {
        return false;
    };
    let Ok(parsed) = DateTime::parse_from_rfc3339(ts) else {
        return false;
    };
    let date = parsed.with_timezone(&Local).format("%Y-%m-%d").to_string();
    acc.entry(date).or_default().sessions += 1;
    true
}

// Fold one message record. Counts user/assistant messages (toolResult excluded)
// and, when an assistant usage block is present, its tokens/cost/model/hour.
// Returns true iff the message was counted.
fn fold_message(v: &Value, acc: &mut BTreeMap<String, DayAcc>) -> bool {
    let msg = v.get("message");
    let role = msg
        .and_then(|m| m.get("role"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if role != "user" && role != "assistant" {
        return false;
    }
    let ts = v
        .get("timestamp")
        .and_then(Value::as_str)
        .or_else(|| msg.and_then(|m| m.get("timestamp")).and_then(Value::as_str));
    let Some(ts) = ts else {
        return false;
    };
    let Ok(parsed) = DateTime::parse_from_rfc3339(ts) else {
        return false;
    };
    let local = parsed.with_timezone(&Local);
    let date = local.format("%Y-%m-%d").to_string();
    let hour = local.hour() as usize;

    let entry = acc.entry(date).or_default();
    entry.messages += 1;

    if let Some(usage) = msg.and_then(|m| m.get("usage")) {
        let u = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
        let (input, output, cache_read, cache_write) =
            (u("input"), u("output"), u("cacheRead"), u("cacheWrite"));
        let total = usage
            .get("totalTokens")
            .and_then(Value::as_u64)
            .unwrap_or(input + output + cache_read + cache_write);
        entry.tokens.input += input;
        entry.tokens.output += output;
        entry.tokens.cache_read += cache_read;
        entry.tokens.cache_write += cache_write;
        entry.tokens.total += total;
        entry.by_hour[hour] += total;
        entry.cost += usage
            .get("cost")
            .and_then(|c| c.get("total"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let model = msg
            .and_then(|m| m.get("model"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        *entry.by_model.entry(model).or_insert(0) += total;
    }
    true
}

// BTreeMap keeps days in ascending date order (YYYY-MM-DD sorts chronologically).
fn finalize(acc: BTreeMap<String, DayAcc>, session_count: u64, total_messages: u64) -> UsageReport {
    let first_day = acc.keys().next().cloned();
    let last_day = acc.keys().next_back().cloned();
    let days = acc
        .into_iter()
        .map(|(date, a)| DayBucket {
            date,
            tokens: a.tokens,
            cost: a.cost,
            messages: a.messages,
            sessions: a.sessions,
            by_model: a.by_model,
            by_hour: a.by_hour,
        })
        .collect();
    UsageReport {
        days,
        meta: UsageMeta {
            session_count,
            total_messages,
            first_day,
            last_day,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("hoy-usage-{tag}-{}", std::process::id()))
    }

    fn write_session(dir: &std::path::Path, session_id: &str, lines: &[&str]) {
        let sdir = dir.join(session_id);
        std::fs::create_dir_all(&sdir).unwrap();
        let body = lines.join("\n");
        std::fs::write(sdir.join("s.jsonl"), body).unwrap();
    }

    #[test]
    fn folds_assistant_usage_into_one_day() {
        let root = tmp("oneday");
        let sessions = root.join("sessions");
        let ts = "2026-07-03T18:00:00.000Z";
        write_session(
            &sessions,
            "sess-a",
            &[
                r#"{"type":"session","id":"sess-a","timestamp":"2026-07-03T18:00:00.000Z","cwd":"/x"}"#,
                &format!(
                    r#"{{"type":"message","timestamp":"{ts}","message":{{"role":"user","timestamp":"{ts}"}}}}"#
                ),
                &format!(
                    r#"{{"type":"message","timestamp":"{ts}","message":{{"role":"assistant","model":"opus","timestamp":"{ts}","usage":{{"input":10,"output":20,"cacheRead":5,"cacheWrite":0,"totalTokens":35,"cost":{{"total":0.5}}}}}}}}"#
                ),
                &format!(
                    r#"{{"type":"message","timestamp":"{ts}","message":{{"role":"assistant","model":"opus","timestamp":"{ts}","usage":{{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3,"cost":{{"total":0.1}}}}}}}}"#
                ),
                r#"{"type":"toolResult","timestamp":"2026-07-03T18:00:01.000Z"}"#,
            ],
        );
        let report = compute_usage_from(&sessions);
        assert_eq!(
            report.days.len(),
            1,
            "all messages share one instant -> one local day"
        );
        let d = &report.days[0];
        assert_eq!(d.tokens.total, 38);
        assert_eq!(d.tokens.input, 11);
        assert_eq!(d.messages, 3, "1 user + 2 assistant, toolResult excluded");
        assert_eq!(d.sessions, 1, "one session started that day");
        assert_eq!(*d.by_model.get("opus").unwrap(), 38);
        assert!((d.cost - 0.6).abs() < 1e-9);
        assert_eq!(
            d.by_hour.iter().sum::<u64>(),
            38,
            "hour histogram totals equal token total"
        );
        assert_eq!(report.meta.session_count, 1);
        assert_eq!(report.meta.total_messages, 3);
        assert_eq!(
            report.meta.first_day.as_deref(),
            report.meta.last_day.as_deref()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn aggregates_across_days_and_sessions_in_order() {
        let root = tmp("multi");
        let sessions = root.join("sessions");
        let early = "2026-07-01T12:00:00.000Z";
        let late = "2026-07-03T12:00:00.000Z";
        write_session(
            &sessions,
            "sess-a",
            &[
                r#"{"type":"session","id":"sess-a","timestamp":"2026-07-01T12:00:00.000Z","cwd":"/x"}"#,
                &format!(
                    r#"{{"type":"message","timestamp":"{early}","message":{{"role":"assistant","model":"opus","usage":{{"totalTokens":100,"cost":{{"total":1.0}}}}}}}}"#
                ),
            ],
        );
        write_session(
            &sessions,
            "sess-b",
            &[
                r#"{"type":"session","id":"sess-b","timestamp":"2026-07-03T12:00:00.000Z","cwd":"/y"}"#,
                &format!(
                    r#"{{"type":"message","timestamp":"{late}","message":{{"role":"assistant","model":"deepseek","usage":{{"totalTokens":40,"cost":{{"total":0.2}}}}}}}}"#
                ),
            ],
        );
        let report = compute_usage_from(&sessions);
        assert_eq!(report.days.len(), 2);
        assert!(report.days[0].date < report.days[1].date, "days ascending");
        assert_eq!(report.days[0].sessions, 1);
        assert_eq!(report.days[1].sessions, 1);
        assert_eq!(report.meta.session_count, 2);
        assert_eq!(
            report.meta.first_day.as_deref(),
            Some(report.days[0].date.as_str())
        );
        assert_eq!(
            report.meta.last_day.as_deref(),
            Some(report.days[1].date.as_str())
        );
        let grand: u64 = report.days.iter().map(|d| d.tokens.total).sum();
        assert_eq!(grand, 140);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_sessions_dir_yields_empty_report() {
        let dir = tmp("missing").join("sessions");
        let report = compute_usage_from(&dir);
        assert!(report.days.is_empty());
        assert_eq!(report.meta.session_count, 0);
        assert_eq!(report.meta.total_messages, 0);
        assert!(report.meta.first_day.is_none());
    }
}
