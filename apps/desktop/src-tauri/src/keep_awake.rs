// HOY-188: keep the machine awake while an agent turn is streaming, so a long
// unattended run (a big edit loop, a build, a multi-minute tool sequence) does
// not idle-sleep out from under the user. Full rationale and platform notes:
// docs/plans/HOY-188-keep-alive-findings.md.
//
// The wake lock (keepawake crate) MUST be created and dropped on the same
// long-lived OS thread: on Windows SetThreadExecutionState is scoped to the
// calling thread, so creating the guard inside a tokio task or command handler
// would leak or clear it when the future resumes on a different worker thread.
// The whole design follows from that: one dedicated owner thread creates, holds,
// and drops the guard, and polls the manager's busy state. macOS and Linux do
// not need the thread affinity, but a single owner thread is correct everywhere.

use crate::sidecar::SidecarManager;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime};

// User toggle (HOY-188): keepAwakeWhileStreaming. The renderer syncs the
// persisted pref here via the set_keep_awake command on boot and on change; the
// owner thread reads it each poll. Defaults to true so behavior matches the pref
// default even before the first sync (e.g. a turn that starts during startup).
static ENABLED: AtomicBool = AtomicBool::new(true);

// Called from the set_keep_awake command. When flipped off mid-turn the owner
// thread releases the wake lock on its next tick (see run()).
pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

// Idle timeouts are minutes, so a coarse poll is fine and self-healing: a missed
// transition just corrects on the next tick, never a leaked lock.
const POLL: Duration = Duration::from_secs(2);

// Hold the lock briefly after the last turn ends so back-to-back turns do not
// churn acquire/release.
const LINGER: Duration = Duration::from_secs(30);

// Spawn the owner thread. Call once from lib.rs setup with the app handle.
pub fn spawn<R: Runtime>(app: AppHandle<R>) {
    std::thread::Builder::new()
        .name("hoy-keep-awake".into())
        .spawn(move || run(app))
        .expect("spawn keep-awake owner thread");
}

fn run<R: Runtime>(app: AppHandle<R>) {
    // The guard lives only on this thread (the Windows requirement). None = the
    // wake lock is released and the machine may idle-sleep.
    let mut guard: Option<keepawake::KeepAwake> = None;
    // When the manager was last observed busy; drives the post-idle linger.
    let mut last_busy: Option<Instant> = None;
    // create() can fail on Linux with no session/system bus (headless, some
    // sandboxes). Log that once, keep polling, and treat the feature as
    // best-effort: never fail or block a turn over it.
    let mut warned = false;

    loop {
        std::thread::sleep(POLL);
        // Gate on the user pref: when off, the effective state is never busy, so
        // the lock is never taken and any held lock is released below.
        let enabled = ENABLED.load(Ordering::Relaxed);
        let busy = enabled && app.state::<SidecarManager>().any_streaming();
        if busy {
            last_busy = Some(Instant::now());
            if guard.is_none() {
                match acquire() {
                    Ok(g) => guard = Some(g),
                    Err(e) => {
                        if !warned {
                            eprintln!("[hoy-desktop] keep-awake unavailable (best-effort): {e}");
                            warned = true;
                        }
                    }
                }
            }
        } else if guard.is_some() {
            // Linger past the last turn to avoid churn between back-to-back
            // turns, but release at once when the user turns the feature off.
            let expired = !enabled || last_busy.map(|t| t.elapsed() >= LINGER).unwrap_or(true);
            if expired {
                // Drop releases the wake lock on THIS thread (Windows-safe).
                guard = None;
            }
        }
    }
}

// caffeinate -i equivalent: keep the SYSTEM awake but let the DISPLAY dim/sleep,
// and do not override an explicit user sleep or lid close.
fn acquire() -> keepawake::Result<keepawake::KeepAwake> {
    keepawake::Builder::default()
        .idle(true)
        .display(false)
        .sleep(false)
        .reason("Hoy agent is running")
        .app_name("Hoy")
        .app_reverse_domain("chat.hoy.desktop")
        .create()
}
