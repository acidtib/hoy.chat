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

pub fn compute_usage_from(_sessions_dir: &Path) -> UsageReport {
    UsageReport::default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("hoy-usage-{tag}-{}", std::process::id()))
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
