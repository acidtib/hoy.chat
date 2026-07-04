# HOY-262 Home Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the desktop home screen into a combined dashboard: a ZCode-style "start a new task" welcome up top and a full local usage-stats surface below.

**Architecture:** A new Rust module (`usage_stats.rs`) reads pi's session transcripts under `~/.hoy/sessions/*/*.jsonl` and folds assistant messages into per-day buckets (local timezone), exposed via a `get_usage_stats` command. The frontend fetches that report once and derives all ranges/streaks/peak-hour/model-ranking client-side, rendered on a redesigned `HomePage.tsx` with hand-rolled charts that honor the square dark theme. No sidecar involvement; the stats pipeline is a pure disk read.

**Tech Stack:** Rust (Tauri v2, serde_json, chrono), React + TypeScript, Zustand store, Tailwind v4 + shadcn, bun test.

## Global Constraints

- No emojis and no em-dashes in code, comments, docs, or commit messages. Use plain hyphens.
- Commit messages are plain, prefixed `HOY-262:` (or `test:` / `chore:`), with NO Co-Authored-By trailer. Commits stay LOCAL on `main`; never push unless explicitly asked.
- Dev/live tests use `~/.hoyd/agent` -> now `~/.hoyd` (debug branded dir). NEVER touch production `~/.hoy`. Clean up any test session dirs afterward.
- The gate is `bun run check` (runs `tsc --noEmit`, `cargo check`, `cargo clippy`, `cargo fmt --check`) from `apps/desktop`. Rust must be clippy-clean and fmt-clean. Frontend tests run with `bun test` from `apps/desktop`.
- Square dark theme: `--radius: 0`, hairline borders (`border border-border`). Match existing settings-panel aesthetic. Reuse `formatTokens` from `src/lib/utils.ts` and the `brand` color tokens (`text-brand`, `bg-brand`) already used in HomePage.

---

## File Structure

**Backend (Slice 1):**
- Create `src-tauri/src/usage_stats.rs` — transcript parsing, per-day aggregation, report types, unit tests. One responsibility: turn a sessions dir into a `UsageReport`.
- Modify `src-tauri/Cargo.toml` — add `chrono`.
- Modify `src-tauri/src/commands.rs` — add the `get_usage_stats` command.
- Modify `src-tauri/src/lib.rs` — register `mod usage_stats;` and the command in `invoke_handler!`.

**Frontend (Slice 2):**
- Modify `src/lib/types.ts` — `UsageReport` / `UsageDay` / `UsageMeta` / `UsageTokenBreakdown`.
- Modify `src/lib/ipc.ts` — `getUsageStats()`.
- Modify `src/state/store.ts` — `usageReport`, `usageLoading`, `refreshUsage()`.
- Create `src/lib/usage.ts` — pure derivations (range filter, totals, streaks, peak hour, model ranking, heatmap grid).
- Create `src/lib/usage.test.ts` — bun tests for the derivations.
- Create `src/components/home/` dashboard pieces: `StatCard.tsx`, `RangeSwitch.tsx`, `ModelRanking.tsx`, `TokenTrendChart.tsx`, `ActivityHeatmap.tsx`, `TaskComposer.tsx`, `UsageDashboard.tsx`.
- Modify `src/components/HomePage.tsx` — greeting + composer + dashboard + existing recents.

---

## Slice 1: backend usage-stats pipeline

### Task 1: chrono dep + module skeleton, types, empty-dir case

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/usage_stats.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod usage_stats;`)

**Interfaces:**
- Produces: `pub fn compute_usage_from(sessions_dir: &Path) -> UsageReport`, `pub fn compute_usage() -> UsageReport`, and the public types `UsageReport { days: Vec<DayBucket>, meta: UsageMeta }`, `DayBucket { date, tokens: TokenBreakdown, cost, messages, by_model: BTreeMap<String,u64>, by_hour: [u64;24] }`, `TokenBreakdown { input, output, cache_read, cache_write, total }`, `UsageMeta { session_count, total_messages, first_day, last_day }`. All serialize camelCase.

- [ ] **Step 1: Add chrono to Cargo.toml**

In `src-tauri/Cargo.toml`, under `[dependencies]` (after the `serde_json` line), add:

```toml
# Local-timezone day/hour bucketing for usage stats (HOY-262). clock enables
# chrono::Local; default features are dropped to avoid the wasm bindings.
chrono = { version = "0.4", default-features = false, features = ["clock", "std"] }
```

- [ ] **Step 2: Write the failing test (empty dir -> empty report)**

Create `src-tauri/src/usage_stats.rs` with the types, function signatures returning `UsageReport::default()`, and this test module:

```rust
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
```

- [ ] **Step 3: Write the module (types + empty-returning bodies)**

Full `src-tauri/src/usage_stats.rs` above the test module:

```rust
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

pub fn compute_usage_from(sessions_dir: &Path) -> UsageReport {
    UsageReport::default()
}
```

- [ ] **Step 4: Register the module**

In `src-tauri/src/lib.rs`, add `mod usage_stats;` to the module list (alphabetical, after `mod subagents_config;` / before `mod workspace;`).

- [ ] **Step 5: Run the test (expect PASS) and gate the build**

Run: `cd apps/desktop && cargo test --manifest-path src-tauri/Cargo.toml usage_stats`
Expected: `missing_sessions_dir_yields_empty_report` passes (empty report is trivially correct).
Run: `cargo check --manifest-path src-tauri/Cargo.toml` -> compiles. Note: `compute_usage_from`'s unused `sessions_dir` param will warn; that is resolved in Task 2. If clippy blocks on the unused param now, prefix it `_sessions_dir` and rename back in Task 2.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/src/usage_stats.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "HOY-262: add usage_stats module skeleton and chrono dep"
```

---

### Task 2: parse a transcript file and fold into local-day buckets

**Files:**
- Modify: `src-tauri/src/usage_stats.rs`

**Interfaces:**
- Consumes: types from Task 1.
- Produces: `compute_usage_from` now fully aggregates; internal `fold_file(&str, &mut BTreeMap<String, DayAcc>) -> (u64, u64)` and `fold_message(&Value, &mut BTreeMap<String, DayAcc>) -> bool`.

- [ ] **Step 1: Write the failing test (single-file folding)**

Add to the `tests` module. Timestamps are a single shared instant so the assertions are timezone-independent (all messages land in ONE local day whatever the runner's tz):

```rust
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
            &format!(r#"{{"type":"message","timestamp":"{ts}","message":{{"role":"user","timestamp":"{ts}"}}}}"#),
            &format!(r#"{{"type":"message","timestamp":"{ts}","message":{{"role":"assistant","model":"opus","timestamp":"{ts}","usage":{{"input":10,"output":20,"cacheRead":5,"cacheWrite":0,"totalTokens":35,"cost":{{"total":0.5}}}}}}}}"#),
            &format!(r#"{{"type":"message","timestamp":"{ts}","message":{{"role":"assistant","model":"opus","timestamp":"{ts}","usage":{{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3,"cost":{{"total":0.1}}}}}}}}"#),
            r#"{"type":"toolResult","timestamp":"2026-07-03T18:00:01.000Z"}"#,
        ],
    );
    let report = compute_usage_from(&sessions);
    assert_eq!(report.days.len(), 1, "all messages share one instant -> one local day");
    let d = &report.days[0];
    assert_eq!(d.tokens.total, 38);
    assert_eq!(d.tokens.input, 11);
    assert_eq!(d.messages, 3, "1 user + 2 assistant, toolResult excluded");
    assert_eq!(*d.by_model.get("opus").unwrap(), 38);
    assert!((d.cost - 0.6).abs() < 1e-9);
    assert_eq!(d.by_hour.iter().sum::<u64>(), 38, "hour histogram totals equal token total");
    assert_eq!(report.meta.session_count, 1);
    assert_eq!(report.meta.total_messages, 3);
    assert_eq!(report.meta.first_day.as_deref(), report.meta.last_day.as_deref());
    let _ = std::fs::remove_dir_all(&root);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml folds_assistant_usage_into_one_day`
Expected: FAIL (report is empty; `days.len()` is 0).

- [ ] **Step 3: Implement the folding**

Replace the stub `compute_usage_from` body and add the helpers:

```rust
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
            Some("session") => sessions += 1,
            Some("message") => {
                if fold_message(&v, acc) {
                    messages += 1;
                }
            }
            _ => {}
        }
    }
    (messages, sessions)
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml usage_stats`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/usage_stats.rs
git commit -m "HOY-262: fold transcript messages into per-day usage buckets"
```

---

### Task 3: multi-day / multi-session aggregation and ordering

**Files:**
- Modify: `src-tauri/src/usage_stats.rs`

**Interfaces:**
- Consumes: Task 2 functions. No new public surface; this task hardens aggregation across days/sessions.

- [ ] **Step 1: Write the failing test (two days, two sessions, ascending order)**

Add to `tests`. Timestamps 48h apart guarantee two distinct local days for any tz:

```rust
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
            &format!(r#"{{"type":"message","timestamp":"{early}","message":{{"role":"assistant","model":"opus","usage":{{"totalTokens":100,"cost":{{"total":1.0}}}}}}}}"#),
        ],
    );
    write_session(
        &sessions,
        "sess-b",
        &[
            r#"{"type":"session","id":"sess-b","timestamp":"2026-07-03T12:00:00.000Z","cwd":"/y"}"#,
            &format!(r#"{{"type":"message","timestamp":"{late}","message":{{"role":"assistant","model":"deepseek","usage":{{"totalTokens":40,"cost":{{"total":0.2}}}}}}}}"#),
        ],
    );
    let report = compute_usage_from(&sessions);
    assert_eq!(report.days.len(), 2);
    assert!(report.days[0].date < report.days[1].date, "days ascending");
    assert_eq!(report.meta.session_count, 2);
    assert_eq!(report.meta.first_day.as_deref(), Some(report.days[0].date.as_str()));
    assert_eq!(report.meta.last_day.as_deref(), Some(report.days[1].date.as_str()));
    let grand: u64 = report.days.iter().map(|d| d.tokens.total).sum();
    assert_eq!(grand, 140);
    let _ = std::fs::remove_dir_all(&root);
}
```

- [ ] **Step 2: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml usage_stats`
Expected: PASS with no code change (the BTreeMap already sorts and aggregates). If it fails, fix `finalize`/ordering until green. This task locks the cross-session behavior with a test even though Task 2's implementation already satisfies it.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/usage_stats.rs
git commit -m "test: lock multi-day multi-session usage aggregation"
```

---

### Task 4: expose the `get_usage_stats` Tauri command

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `crate::usage_stats::{compute_usage, UsageReport}`.
- Produces: command `get_usage_stats() -> Result<UsageReport, String>` registered in `invoke_handler!`. Frontend calls it as `invoke("get_usage_stats")`.

- [ ] **Step 1: Add the command to commands.rs**

At the end of `src-tauri/src/commands.rs` add:

```rust
// HOY-262: aggregate local usage stats from pi's session transcripts. Pure disk
// read, so it runs on the blocking pool rather than tying up an async worker.
#[tauri::command]
pub async fn get_usage_stats() -> Result<crate::usage_stats::UsageReport, String> {
    tauri::async_runtime::spawn_blocking(crate::usage_stats::compute_usage)
        .await
        .map_err(|e| format!("usage stats task failed: {e}"))
}
```

- [ ] **Step 2: Register it in the handler**

In `src-tauri/src/lib.rs`, inside `tauri::generate_handler![ ... ]`, add `commands::get_usage_stats,` next to the other read commands (e.g. after `commands::get_session_stats,`). Watch the trailing comma so the macro list stays valid.

- [ ] **Step 3: Gate the build**

Run: `cd apps/desktop && cargo check --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml && cargo fmt --check --manifest-path src-tauri/Cargo.toml`
Expected: all clean. Run `cargo test --manifest-path src-tauri/Cargo.toml usage_stats` once more -> green.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "HOY-262: expose get_usage_stats command"
```

---

## Slice 2: dashboard frontend

### Task 5: TS types, IPC, and store wiring

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/ipc.ts`
- Modify: `src/state/store.ts`

**Interfaces:**
- Produces: `UsageReport`/`UsageDay`/`UsageMeta`/`UsageTokenBreakdown` types; `getUsageStats(): Promise<UsageReport>`; store fields `usageReport: UsageReport | null`, `usageLoading: boolean`, action `refreshUsage(): Promise<void>`.

- [ ] **Step 1: Add types**

Append to `src/lib/types.ts`:

```ts
// Mirror of usage_stats.rs UsageReport (HOY-262). Per-day buckets in ascending
// date order; the frontend derives ranges/streaks/peak-hour from these.
export interface UsageTokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}
export interface UsageDay {
  date: string; // YYYY-MM-DD, local day
  tokens: UsageTokenBreakdown;
  cost: number;
  messages: number;
  byModel: Record<string, number>;
  byHour: number[]; // length 24, tokens per local hour
}
export interface UsageMeta {
  sessionCount: number;
  totalMessages: number;
  firstDay: string | null;
  lastDay: string | null;
}
export interface UsageReport {
  days: UsageDay[];
  meta: UsageMeta;
}
```

- [ ] **Step 2: Add the IPC wrapper**

In `src/lib/ipc.ts`, add `UsageReport` to the type import from `./types` (or the existing types import block), then near `getSessionStats`:

```ts
// HOY-262: aggregate local usage stats parsed from session transcripts.
export function getUsageStats(): Promise<UsageReport> {
  return invoke<UsageReport>("get_usage_stats");
}
```

- [ ] **Step 3: Wire the store**

In `src/state/store.ts`:
1. Add `UsageReport` to the type import from `../lib/types` and `getUsageStats` to the import from `../lib/ipc`.
2. In the state interface (near `stats: Record<string, SessionStats | null>;`), add:

```ts
  // HOY-262: aggregate local usage stats for the home dashboard. Loaded lazily
  // when the dashboard mounts; null until the first fetch resolves.
  usageReport: UsageReport | null;
  usageLoading: boolean;
```

3. In the action-signatures section, add `refreshUsage: () => Promise<void>;`.
4. In the initial state object, add `usageReport: null,` and `usageLoading: false,`.
5. Near `refreshStats`, add the action:

```ts
  refreshUsage: async () => {
    set({ usageLoading: true });
    try {
      const report = await getUsageStats();
      set({ usageReport: report, usageLoading: false });
    } catch {
      // Best-effort: leave the last report in place and drop the spinner.
      set({ usageLoading: false });
    }
  },
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/desktop && bun run check:ts`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/types.ts apps/desktop/src/lib/ipc.ts apps/desktop/src/state/store.ts
git commit -m "HOY-262: wire usage report types, ipc, and store action"
```

---

### Task 6: pure derivation helpers + tests

**Files:**
- Create: `src/lib/usage.ts`
- Create: `src/lib/usage.test.ts`

**Interfaces:**
- Consumes: `UsageDay` from `./types`.
- Produces: `type UsageRange = "all" | "30d" | "7d"`; `dateKey(Date): string`; `daysInRange(days, range, today?)`; `totals(days, sessionCount)`; `streaks(days, today?)`; `peakHour(days): number | null`; `modelRanking(days): ModelShare[]`; `heatmapGrid(days, weeks, today?): HeatDay[][]`; types `UsageTotals`, `Streaks`, `ModelShare`, `HeatDay`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/usage.test.ts`:

```ts
import { test, expect } from "bun:test";
import type { UsageDay } from "./types";
import { daysInRange, totals, streaks, peakHour, modelRanking, dateKey } from "./usage";

function day(date: string, total: number, byModel: Record<string, number> = {}, byHour?: number[]): UsageDay {
  return {
    date,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
    cost: 0,
    messages: 1,
    byModel,
    byHour: byHour ?? new Array(24).fill(0),
  };
}

const today = new Date("2026-07-10T12:00:00");

test("daysInRange filters by trailing window", () => {
  const days = [day("2026-06-01", 1), day("2026-07-05", 1), day("2026-07-10", 1)];
  expect(daysInRange(days, "all", today).length).toBe(3);
  expect(daysInRange(days, "7d", today).map((d) => d.date)).toEqual(["2026-07-05", "2026-07-10"]);
  expect(daysInRange(days, "30d", today).length).toBe(2);
});

test("totals sums tokens/messages and counts active days", () => {
  const t = totals([day("2026-07-01", 100), day("2026-07-02", 40)], 3);
  expect(t.tokens).toBe(140);
  expect(t.messages).toBe(2);
  expect(t.activeDays).toBe(2);
  expect(t.sessions).toBe(3);
});

test("streaks: current counts back from today, longest finds the longest run", () => {
  const days = [
    day("2026-07-01", 1),
    day("2026-07-02", 1),
    day("2026-07-03", 1),
    day("2026-07-09", 1),
    day("2026-07-10", 1),
  ];
  const s = streaks(days, today);
  expect(s.current).toBe(2); // 07-09, 07-10
  expect(s.longest).toBe(3); // 07-01..07-03
});

test("streaks: current tolerates today having no activity yet", () => {
  const days = [day("2026-07-08", 1), day("2026-07-09", 1)];
  expect(streaks(days, today).current).toBe(2); // today 07-10 empty, streak ends yesterday
});

test("peakHour returns the busiest local hour or null", () => {
  const hours = new Array(24).fill(0);
  hours[21] = 500;
  expect(peakHour([day("2026-07-10", 500, {}, hours)])).toBe(21);
  expect(peakHour([day("2026-07-10", 0)])).toBeNull();
});

test("modelRanking ranks by tokens with shares", () => {
  const rows = modelRanking([day("2026-07-10", 100, { opus: 75, deepseek: 25 })]);
  expect(rows[0].model).toBe("opus");
  expect(rows[0].share).toBeCloseTo(0.75, 5);
  expect(rows[1].model).toBe("deepseek");
});

test("dateKey is local YYYY-MM-DD", () => {
  expect(dateKey(new Date("2026-07-03T23:30:00"))).toBe("2026-07-03");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/desktop && bun test src/lib/usage.test.ts`
Expected: FAIL (module `./usage` not found).

- [ ] **Step 3: Implement `src/lib/usage.ts`**

```ts
import type { UsageDay } from "./types";

export type UsageRange = "all" | "30d" | "7d";

// Local YYYY-MM-DD for a Date, matching the keys the Rust side emits.
export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Trailing-window filter. "all" returns every day; "7d"/"30d" keep days whose
// key is on or after the window's first day (inclusive of today).
export function daysInRange(days: UsageDay[], range: UsageRange, today: Date = new Date()): UsageDay[] {
  if (range === "all") return days;
  const span = range === "7d" ? 7 : 30;
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - (span - 1));
  const cutoffKey = dateKey(cutoff);
  return days.filter((d) => d.date >= cutoffKey);
}

export interface UsageTotals {
  tokens: number;
  cost: number;
  messages: number;
  activeDays: number;
  sessions: number;
}
export function totals(days: UsageDay[], sessionCount: number): UsageTotals {
  let tokens = 0;
  let cost = 0;
  let messages = 0;
  for (const d of days) {
    tokens += d.tokens.total;
    cost += d.cost;
    messages += d.messages;
  }
  return { tokens, cost, messages, activeDays: days.length, sessions: sessionCount };
}

export interface Streaks {
  current: number;
  longest: number;
}
export function streaks(days: UsageDay[], today: Date = new Date()): Streaks {
  const set = new Set(days.map((d) => d.date));
  const sorted = [...set].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const key of sorted) {
    run = prev && isNextDay(prev, key) ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = key;
  }
  let current = 0;
  const cursor = new Date(today);
  // Allow today to be empty (streak may end yesterday) before walking back.
  if (!set.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (set.has(dateKey(cursor))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { current, longest };
}

function isNextDay(a: string, b: string): boolean {
  const da = new Date(`${a}T00:00:00`);
  da.setDate(da.getDate() + 1);
  return dateKey(da) === b;
}

// Busiest local hour (0-23) by token total across the given days; null if idle.
export function peakHour(days: UsageDay[]): number | null {
  const buckets = new Array(24).fill(0);
  for (const d of days) for (let h = 0; h < 24; h++) buckets[h] += d.byHour[h] ?? 0;
  let best = -1;
  let bestVal = 0;
  for (let h = 0; h < 24; h++) {
    if (buckets[h] > bestVal) {
      bestVal = buckets[h];
      best = h;
    }
  }
  return best >= 0 ? best : null;
}

export interface ModelShare {
  model: string;
  tokens: number;
  share: number;
}
export function modelRanking(days: UsageDay[]): ModelShare[] {
  const byModel = new Map<string, number>();
  for (const d of days) {
    for (const [m, t] of Object.entries(d.byModel)) byModel.set(m, (byModel.get(m) ?? 0) + t);
  }
  const grand = [...byModel.values()].reduce((a, b) => a + b, 0);
  return [...byModel.entries()]
    .map(([model, tokens]) => ({ model, tokens, share: grand > 0 ? tokens / grand : 0 }))
    .sort((a, b) => b.tokens - a.tokens);
}

export interface HeatDay {
  date: string;
  tokens: number;
}
// A weeks x 7 grid (rows Sunday..Saturday) ending at the week containing today.
// Each cell carries that day's total tokens (0 when absent).
export function heatmapGrid(days: UsageDay[], weeks: number, today: Date = new Date()): HeatDay[][] {
  const byDate = new Map(days.map((d) => [d.date, d.tokens.total]));
  const lastSunday = new Date(today);
  lastSunday.setDate(lastSunday.getDate() - lastSunday.getDay());
  const cols: HeatDay[][] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const col: HeatDay[] = [];
    for (let r = 0; r < 7; r++) {
      const d = new Date(lastSunday);
      d.setDate(d.getDate() - w * 7 + r);
      const key = dateKey(d);
      col.push({ date: key, tokens: byDate.get(key) ?? 0 });
    }
    cols.push(col);
  }
  return cols;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/lib/usage.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/usage.ts apps/desktop/src/lib/usage.test.ts
git commit -m "HOY-262: add usage derivation helpers with tests"
```

---

### Task 7: presentational primitives (StatCard, RangeSwitch, ModelRanking)

**Files:**
- Create: `src/components/home/StatCard.tsx`
- Create: `src/components/home/RangeSwitch.tsx`
- Create: `src/components/home/ModelRanking.tsx`

**Interfaces:**
- Consumes: `UsageRange`, `ModelShare` from `@/lib/usage`; `formatTokens`, `cn` from `@/lib/utils`.
- Produces: `<StatCard label value sub? />`, `<RangeSwitch value onChange />`, `<ModelRanking rows />`.

- [ ] **Step 1: StatCard**

```tsx
// A single labeled metric tile for the usage dashboard (HOY-262). Square,
// hairline-bordered to match the settings-panel aesthetic.
export function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-border px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums tracking-tight text-foreground">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
```

- [ ] **Step 2: RangeSwitch**

```tsx
import { cn } from "@/lib/utils";
import type { UsageRange } from "@/lib/usage";

const OPTIONS: { value: UsageRange; label: string }[] = [
  { value: "all", label: "All Time" },
  { value: "30d", label: "30 Days" },
  { value: "7d", label: "7 Days" },
];

export function RangeSwitch({ value, onChange }: { value: UsageRange; onChange: (r: UsageRange) => void }) {
  return (
    <div className="inline-flex divide-x divide-border border border-border">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "px-2.5 py-1 text-xs transition-colors",
            value === o.value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: ModelRanking**

```tsx
import type { ModelShare } from "@/lib/usage";
import { formatTokens } from "@/lib/utils";

export function ModelRanking({ rows }: { rows: ModelShare[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No model usage yet.</p>;
  }
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.model}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="min-w-0 truncate text-foreground">{r.model}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatTokens(r.tokens)} - {Math.round(r.share * 100)}%
            </span>
          </div>
          <div className="mt-1 h-1.5 bg-accent/40">
            <div className="h-full bg-brand" style={{ width: `${Math.max(2, r.share * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck and commit**

Run: `cd apps/desktop && bun run check:ts`
Expected: no errors.

```bash
git add apps/desktop/src/components/home/StatCard.tsx apps/desktop/src/components/home/RangeSwitch.tsx apps/desktop/src/components/home/ModelRanking.tsx
git commit -m "HOY-262: add usage stat card, range switch, model ranking"
```

---

### Task 8: TokenTrendChart (daily bars + per-model hover)

**Files:**
- Create: `src/components/home/TokenTrendChart.tsx`

**Interfaces:**
- Consumes: `UsageDay` from `@/lib/types`; `formatTokens` from `@/lib/utils`.
- Produces: `<TokenTrendChart days={UsageDay[]} />`.

- [ ] **Step 1: Implement**

```tsx
import { useState } from "react";
import type { UsageDay } from "@/lib/types";
import { formatTokens } from "@/lib/utils";

// Daily token bars with a details panel showing the hovered day's per-model
// split (HOY-262). Hand-rolled flex bars to keep the square dark aesthetic and
// avoid a charting dependency.
export function TokenTrendChart({ days }: { days: UsageDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (days.length === 0) {
    return <div className="border border-border px-4 py-8 text-center text-xs text-muted-foreground">No activity in this range.</div>;
  }
  const max = Math.max(1, ...days.map((d) => d.tokens.total));
  const active = hover != null ? days[hover] : null;
  return (
    <div>
      <div className="flex h-32 items-end gap-px">
        {days.map((d, i) => (
          <button
            key={d.date}
            type="button"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            className="group relative h-full min-w-0 flex-1"
            aria-label={`${d.date}: ${formatTokens(d.tokens.total)} tokens`}
          >
            <div
              className="absolute bottom-0 w-full bg-brand/60 transition-colors group-hover:bg-brand"
              style={{ height: `${Math.max(1, (d.tokens.total / max) * 100)}%` }}
            />
          </button>
        ))}
      </div>
      <div className="mt-2 min-h-[2.5rem] border border-border px-2 py-1.5 text-xs">
        {active ? (
          <>
            <div className="flex justify-between">
              <span className="font-medium text-foreground">{active.date}</span>
              <span className="tabular-nums text-muted-foreground">{formatTokens(active.tokens.total)} tokens</span>
            </div>
            <div className="mt-1 space-y-0.5">
              {Object.entries(active.byModel)
                .sort((a, b) => b[1] - a[1])
                .map(([m, t]) => (
                  <div key={m} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate text-muted-foreground">{m}</span>
                    <span className="tabular-nums text-foreground">{formatTokens(t)}</span>
                  </div>
                ))}
            </div>
          </>
        ) : (
          <span className="text-muted-foreground">Hover a bar for the daily breakdown.</span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck and commit**

Run: `cd apps/desktop && bun run check:ts` -> clean.

```bash
git add apps/desktop/src/components/home/TokenTrendChart.tsx
git commit -m "HOY-262: add daily token trend chart"
```

---

### Task 9: ActivityHeatmap (multi-week grid)

**Files:**
- Create: `src/components/home/ActivityHeatmap.tsx`

**Interfaces:**
- Consumes: `UsageDay` from `@/lib/types`; `heatmapGrid` from `@/lib/usage`; `formatTokens` from `@/lib/utils`.
- Produces: `<ActivityHeatmap days={UsageDay[]} />`.

- [ ] **Step 1: Implement**

```tsx
import type { UsageDay } from "@/lib/types";
import { heatmapGrid } from "@/lib/usage";
import { formatTokens } from "@/lib/utils";

// 53-week activity grid (HOY-262). Intensity scales opacity of the brand color;
// the row scrolls horizontally if the column is too narrow to hold a full year.
const WEEKS = 53;

export function ActivityHeatmap({ days }: { days: UsageDay[] }) {
  const grid = heatmapGrid(days, WEEKS);
  const max = Math.max(1, ...days.map((d) => d.tokens.total));
  return (
    <div className="flex gap-[2px] overflow-x-auto pb-1">
      {grid.map((col, ci) => (
        <div key={ci} className="flex flex-col gap-[2px]">
          {col.map((cell) => {
            const ratio = cell.tokens > 0 ? 0.2 + 0.8 * (cell.tokens / max) : 0;
            return (
              <div
                key={cell.date}
                title={`${cell.date}: ${formatTokens(cell.tokens)} tokens`}
                className="size-2.5 shrink-0 border border-border/40 bg-brand"
                style={{ opacity: ratio || undefined, backgroundColor: cell.tokens > 0 ? undefined : "transparent" }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck and commit**

Run: `cd apps/desktop && bun run check:ts` -> clean.

```bash
git add apps/desktop/src/components/home/ActivityHeatmap.tsx
git commit -m "HOY-262: add activity heatmap"
```

---

### Task 10: TaskComposer (start-a-new-task input)

**Files:**
- Create: `src/components/home/TaskComposer.tsx`

**Interfaces:**
- Consumes: store `addThread(projectId): string` and `setDraft(threadId, value)`; `Button` from `@/components/ui/button`.
- Produces: `<TaskComposer projectId={string | null} />`. On submit: creates a thread in `projectId` (which also opens it) and prefills the typed text as its draft.

- [ ] **Step 1: Implement**

```tsx
import { useState } from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/state/store";

// The prominent "start a new task" input on the home dashboard (HOY-262).
// Submitting creates a thread in `projectId` (addThread also opens it) and
// prefills the typed text as the thread draft; the thread composer sends it.
// Auto-send on open is a follow-up (see HOY-262 out-of-scope).
export function TaskComposer({ projectId }: { projectId: string | null }) {
  const [text, setText] = useState("");
  const addThread = useSessionStore((s) => s.addThread);
  const setDraft = useSessionStore((s) => s.setDraft);
  const disabled = !projectId;

  function start() {
    const trimmed = text.trim();
    if (!trimmed || !projectId) return;
    const id = addThread(projectId);
    setDraft(id, trimmed);
    setText("");
  }

  return (
    <div className="border border-border bg-card focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/60">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            start();
          }
        }}
        disabled={disabled}
        rows={3}
        placeholder={disabled ? "Open a project to start a task..." : "Start a new task..."}
        className="w-full resize-none bg-transparent px-3.5 py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className="flex justify-end px-2 pb-2">
        <Button size="icon" onClick={start} disabled={disabled || text.trim().length === 0} aria-label="Start task">
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </div>
  );
}
```

Note: confirm `Button` supports `size="icon"` (shadcn default). If not, use `size="sm"` with the icon.

- [ ] **Step 2: Typecheck and commit**

Run: `cd apps/desktop && bun run check:ts` -> clean.

```bash
git add apps/desktop/src/components/home/TaskComposer.tsx
git commit -m "HOY-262: add home task composer"
```

---

### Task 11: UsageDashboard composition + HomePage integration + live-verify

**Files:**
- Create: `src/components/home/UsageDashboard.tsx`
- Modify: `src/components/HomePage.tsx`

**Interfaces:**
- Consumes: store `usageReport`, `usageLoading`, `refreshUsage`; helpers from `@/lib/usage`; the Task 7-10 components.
- Produces: `<UsageDashboard />` (self-loads on mount); HomePage renders greeting + `<TaskComposer />` + existing actions + `<UsageDashboard />` + recents.

- [ ] **Step 1: UsageDashboard**

Create `src/components/home/UsageDashboard.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { useSessionStore } from "@/state/store";
import { daysInRange, modelRanking, peakHour, streaks, totals, type UsageRange } from "@/lib/usage";
import { formatTokens } from "@/lib/utils";
import { StatCard } from "./StatCard";
import { RangeSwitch } from "./RangeSwitch";
import { ModelRanking } from "./ModelRanking";
import { TokenTrendChart } from "./TokenTrendChart";
import { ActivityHeatmap } from "./ActivityHeatmap";

// The usage-stats section of the home dashboard (HOY-262). Self-loads the
// report on mount; the report is fetched once and every range is derived
// client-side so the range switch never re-hits disk.
export function UsageDashboard() {
  const report = useSessionStore((s) => s.usageReport);
  const loading = useSessionStore((s) => s.usageLoading);
  const refreshUsage = useSessionStore((s) => s.refreshUsage);
  const [range, setRange] = useState<UsageRange>("all");

  useEffect(() => {
    void refreshUsage();
  }, [refreshUsage]);

  const view = useMemo(() => {
    if (!report) return null;
    const days = daysInRange(report.days, range);
    return {
      days,
      totals: totals(days, report.meta.sessionCount),
      streaks: streaks(report.days),
      peak: peakHour(days),
      models: modelRanking(days),
    };
  }, [report, range]);

  if (loading && !report) {
    return <div className="h-40 animate-pulse border border-border bg-accent/20" />;
  }
  if (!report || report.days.length === 0) {
    return (
      <div className="border border-border px-4 py-8 text-center text-sm text-muted-foreground">
        No usage yet. Your token trends, streaks, and model breakdown show up here as you work.
      </div>
    );
  }
  const v = view!;
  return (
    <section className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-foreground">Usage</h2>
        <RangeSwitch value={range} onChange={setRange} />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard label="Tokens" value={formatTokens(v.totals.tokens)} />
        <StatCard label="Sessions" value={String(v.totals.sessions)} />
        <StatCard label="Messages" value={String(v.totals.messages)} />
        <StatCard label="Active days" value={String(v.totals.activeDays)} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <StatCard label="Current streak" value={`${v.streaks.current}d`} sub={`Longest ${v.streaks.longest}d`} />
        <StatCard label="Peak hour" value={v.peak != null ? formatHour(v.peak) : "-"} />
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Daily tokens</p>
        <TokenTrendChart days={v.days} />
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Activity</p>
        <ActivityHeatmap days={report.days} />
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Models</p>
        <ModelRanking rows={v.models} />
      </div>
    </section>
  );
}

function formatHour(h: number): string {
  const period = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${period}`;
}
```

- [ ] **Step 2: Integrate into HomePage**

In `src/components/HomePage.tsx`:
1. Add imports: `import { TaskComposer } from "@/components/home/TaskComposer";` and `import { UsageDashboard } from "@/components/home/UsageDashboard";`.
2. Add a greeting derived from the local hour, just inside `HomePage()` before the return:

```tsx
  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  })();
```

3. Replace the `Threads` heading block (the `<div className="flex items-center gap-2.5">...</div>` with the `Sparkle` + `<h1>Threads</h1>`) with a greeting heading, and insert the composer directly under it. The new top of the inner column becomes:

```tsx
        <div className="flex items-center gap-2.5">
          <Sparkle className="size-[18px] text-brand" />
          <h1 className="text-lg font-semibold tracking-tight text-foreground">{greeting}</h1>
        </div>

        <TaskComposer projectId={targetProjectId} />
```

4. Keep the existing action row (New thread / project picker / Open project) exactly as-is (it stays useful for a blank thread).
5. Insert `<UsageDashboard />` between the action row and the `Recent` block:

```tsx
        <UsageDashboard />
```

Leave the recents block and the no-projects fallback unchanged.

- [ ] **Step 3: Gate**

Run: `cd apps/desktop && bun run check` (ts + rust + clippy + fmt) and `bun test`.
Expected: all green. Fix any type errors (e.g. `Button size="icon"` availability from Task 10).

- [ ] **Step 4: Live-verify in the dev app**

Rebuild is not needed for frontend-only changes; the running dev app hot-reloads. If not running, start it:

Run: `cd apps/desktop && bun run tauri:dev` (uses the `hoyd` namespace and `~/.hoyd`).

Using the Tauri MCP driver (debug bridge, port 9223): take a `webview_screenshot` of the home screen. Verify: greeting renders, the task composer accepts text and Enter opens a new thread with the text prefilled in the thread composer, the Usage section shows real numbers from `~/.hoyd/sessions` (there is existing dev data there), the range switch changes the cards/chart without a reload, hovering a trend bar shows the per-model split, and the heatmap renders. Screenshot the result. NEVER point the dev app at production `~/.hoy`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/home/UsageDashboard.tsx apps/desktop/src/components/HomePage.tsx
git commit -m "HOY-262: compose usage dashboard into the home screen"
```

---

## Self-Review

**Spec coverage (HOY-262):**
- Combined dashboard (greeting + composer + stats + recents) -> Tasks 10, 11.
- Backend pipeline reading `~/.hoy/sessions/*/*.jsonl`, per-day local buckets, `get_usage_stats` command, chrono, single-payload -> Tasks 1-4.
- Full ZCode parity stats: tokens/sessions/messages/active-days cards -> Task 11; streaks + peak hour -> Tasks 6, 11; daily token trend with per-model hover -> Task 8; activity heatmap -> Task 9; model ranking -> Task 7; range switch All Time/30d/7d derived client-side -> Tasks 6, 11.
- Composer prefill-draft behavior -> Task 10.
- Async load with skeleton so home never blocks -> Tasks 5, 11.
- Dropped Coding Plan tab, no charting lib, no cached aggregation -> honored (hand-rolled charts, compute-on-mount).
- Rust unit tests (bucketing, streak edges, model folding, empty dir) -> Tasks 1-3 and 6 (streak edges live in the TS derivation, tested in Task 6).

**Type consistency:** Rust `DayBucket`/`TokenBreakdown`/`UsageMeta` serialize camelCase and match the TS `UsageDay`/`UsageTokenBreakdown`/`UsageMeta` field-for-field (`byModel`, `byHour`, `cacheRead`, `sessionCount`, `firstDay`). `addThread(projectId): string` and `setDraft(threadId, value)` signatures match store.ts. `formatTokens` imported from `@/lib/utils` (confirmed exported).

**Placeholder scan:** none. Every code step carries complete code.

**Open verification during execution:** confirm `Button` exposes `size="icon"` (Task 10); confirm the `brand` opacity styling reads well against the dark theme during live-verify (Task 11) and adjust intensity if needed.
