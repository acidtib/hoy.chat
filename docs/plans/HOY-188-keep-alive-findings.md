# HOY-188: Keep the computer awake while the agent is running

Spike (timeboxed). Question from the ticket: can
[`keepawake-rs`](https://github.com/segevfiner/keepawake-rs) be used to keep the
computer awake while a thread / threads are running? "A thread running" here
means a Pi turn is streaming: the machine must not idle-sleep out from under a
long agent run (a big edit loop, a build, a multi-minute tool sequence) when the
user walks away.

## Verdict: YES, use `keepawake` directly from the Rust core (not a JS plugin)

`keepawake` (crate `keepawake`, repo `keepawake-rs`) is the right primitive: one
small cross-platform crate, RAII guard, covers Windows / macOS / Linux with the
native mechanisms (`SetThreadExecutionState`, IOKit `IOPMAssertion`, D-Bus
inhibitors). Drive it from Rust because our "is a turn running" signal already
lives in Rust (`SidecarManager` / `PiProcess::is_streaming()`), not in the
renderer. Do NOT reach for the JS-facing wrapper plugins
(`tauri-plugin-keepawake`, `tauri-plugin-nosleep`) — they invert the control
layer (renderer drives acquire/release), which is exactly wrong for us.

One hard implementation landmine on Windows (below): the guard MUST be created
and dropped on the same long-lived OS thread. That single constraint dictates the
whole design: **one owner thread that holds the guard and polls the manager's
busy state**, not a guard created inside async command handlers or tokio tasks.

Scope is Rust-core only, no renderer changes, no new RPC. Estimated a small,
self-contained change (one new module + a supervisor thread spawned in
`lib.rs setup`, a new `any_streaming()` on the manager, one dependency).

## What `keepawake` is (pinned facts, v0.6.0)

- Crate `keepawake` 0.6.0, published 2025-10-09, MIT, MSRV 1.64, actively
  maintained (15 releases). Also ships a CLI and an experimental C API; we only
  want the library.
- API is a builder that returns an RAII guard:

  ```rust
  let _guard = keepawake::Builder::default()
      .idle(true)                       // prevent idle-triggered SYSTEM sleep
      .display(false)                   // let the screen dim/sleep (see below)
      .sleep(false)                     // do not fight user-initiated sleep
      .reason("Hoy agent is running")
      .app_name("Hoy")
      .app_reverse_domain("chat.hoy.desktop")
      .create()?;                       // -> keepawake::Result<KeepAwake>
  // ... machine stays awake while `_guard` is alive ...
  drop(_guard);                         // releases; machine may sleep again
  ```

- Three independent knobs: `display` (screen on), `idle` (no idle sleep),
  `sleep` (block explicit sleep, generally only honored on AC). `create()`
  returns `Result<KeepAwake>`; `KeepAwake` releases on `Drop`.

### Platform mechanics (verified against the crate source)

- **Windows** (`src/sys/windows.rs`): calls `SetThreadExecutionState` with
  `ES_CONTINUOUS` plus `ES_SYSTEM_REQUIRED` (idle), `ES_DISPLAY_REQUIRED`
  (display), `ES_AWAYMODE_REQUIRED` (sleep). Stores the previous state; `Drop`
  restores it. **There is no internal helper thread** — the execution state is
  set on whatever thread calls `create()`, and Windows scopes it to that thread.
- **macOS** (`src/sys/macos.rs`): IOKit `IOPMAssertionCreateWithName`
  (`NoIdleSleep` / `NoDisplaySleep` / `PreventUserIdleSystemSleep`). Assertion
  released on `Drop`. No thread affinity concern.
- **Linux** (`src/sys/linux.rs`): zbus (blocking). `display` -> the session-bus
  `org.freedesktop.ScreenSaver.Inhibit` cookie; `idle` / `sleep` -> system-bus
  `org.freedesktop.login1.Manager.Inhibit` returning a lock **fd** held in the
  struct. `Drop` un-inhibits / drops the fds. **`create()` returns `Err` if there
  is no session/system bus or no logind** — it does not silently degrade.

## THE Windows landmine (this decides the architecture)

`SetThreadExecutionState` sets the execution state for the **calling thread**,
and the state only lasts while that thread lives. Because keepawake's Windows
impl has no internal thread, if we call `.create()` inside a tokio task (or any
work-stealing / short-lived thread):

- `set()` runs on worker thread A; the future may resume and `Drop` on worker
  thread B. `Drop` restores `previous` on B (a no-op there), while A still
  carries `ES_CONTINUOUS` until A happens to die — a phantom, un-droppable lock.
- Or the task's thread ends before `Drop`, and Windows clears the state early —
  the machine sleeps mid-turn, silently.

Mitigation, and the shape of the whole feature: **own a single dedicated OS
thread (`std::thread`, pinned, never work-stealing) that creates, holds, and
drops the guard.** macOS and Linux don't need this, but a single owner thread is
correct everywhere and costs nothing, so build it once for all platforms.

## The "a thread is running" signal already exists

Our turn lifecycle gives a clean, authoritative busy signal per session:

- Turn start: `send_prompt` attaches the event Channel via
  `PiProcess::set_sink` (`commands.rs:378`).
- Turn end: the reader thread detaches the sink on the terminal `agent_end`
  (`sidecar.rs:416`, `sink.take()`), or on stream close (`sidecar.rs:157`);
  preflight errors call `clear_sink` (`commands.rs:387,394`).
- Query: `PiProcess::is_streaming()` == "sink is attached" == "a turn is
  streaming on this session" (`sidecar.rs:328`).

`SidecarManager` holds `sessions: HashMap<SessionId, Arc<PiProcess>>`
(`sidecar.rs:702`). "Any thread running" is just: any session `is_streaming()`.
This is already multi-session-correct, matching the keyed-by-`sessionId`
non-negotiable: the machine stays awake while >=1 session is mid-turn.

## Recommended design: poll-from-the-owner-thread (least code, least risk)

Because Windows forces a dedicated owner thread anyway, the simplest robust
design is to have that thread poll the manager's busy state rather than wire an
event-driven refcount through the reader thread.

1. New `SidecarManager::any_streaming(&self) -> bool` — lock `sessions`, return
   `values().any(|p| p.is_streaming())`. Cheap (mutex + small map scan).
2. New module `src-tauri/src/keep_awake.rs`: spawn one `std::thread` in `lib.rs`
   `setup` (with the `AppHandle`/manager state). Loop:
   - poll `any_streaming()` every ~1-2s;
   - on `false -> true`: `create()` the guard on this thread, store `Some`;
   - on `true -> false`: keep the guard for a short **linger** (e.g. 30s) to
     avoid churn between back-to-back turns, then `drop` it;
   - `create()` errors (e.g. Linux no-bus) are logged once and treated as
     best-effort — never fail or block a turn.
   Guard is created and dropped on this one thread -> Windows-safe by construction.

Latency (up to ~2s to acquire after a turn starts) is irrelevant: idle timeouts
are minutes. Polling also self-heals — a missed transition just corrects on the
next tick, no leaked lock.

Alternative (event-driven refcount): increment on `set_sink`, decrement on the
`sink.take()`/`clear_sink` paths, and have the owner thread react via a Condvar.
More precise, but it threads a coordinator handle through the reader thread's
`route_message` free function and every teardown path, and still needs the owner
thread for Windows. Not worth the extra surface for a minutes-scale timer;
recommend the poll. Revisit only if profiling ever flags the poll (it won't).

## Knob recommendation: `idle=true`, `display=false`, `sleep=false`

We want the equivalent of `caffeinate -i`: keep the **system** awake so the agent
keeps running, but let the **display** dim/sleep (a long unattended run
shouldn't burn the panel), and don't override an explicit user sleep / lid close.
Make it a setting later ("Keep the computer awake while the agent is working",
default on); MVP of the feature can hardcode these three.

## Alternatives considered

- **Tauri wrapper plugins** (`tauri-plugin-keepawake`, `tauri-plugin-nosleep`,
  `tauri-plugin-screen-wake-lock`): all expose JS commands so the **renderer**
  drives acquire/release. Our signal is in Rust; routing it out to JS and back is
  pure inversion. Rejected. (`tauri-plugin-keepawake`'s GitHub repo 404s now,
  crate still listed — another reason to depend on the maintained base crate.)
- **Raw OS calls ourselves** (`SetThreadExecutionState` / IOKit / zbus per
  platform): that is precisely what `keepawake` already is, tested and
  maintained. No reason to reimplement three platforms' FFI. Rejected.
- **Web `navigator.wakeLock`** (from the webview): display-only, requires a
  visible/focused document, and is the wrong layer. Rejected.

## Dependency / cost

- Add `keepawake = "0.6"` to `apps/desktop/src-tauri/Cargo.toml`, pinned. Pulls
  zbus on Linux, the `windows` crate on Windows, IOKit/CoreFoundation on macOS.
  Moderate, all platform-native. Add a version-bump line to `TODO.md`.
- No new RPC, no renderer changes, no sidecar changes for the always-on version.

## Caveats / open questions for implementation

- **Windows thread-affinity is the whole ballgame** — enforce the single owner
  thread; do not create the guard in a `#[tauri::command]` or tokio task. Add a
  code comment citing this doc.
- **Linux is best-effort.** `create()` `Err`s without a session/system bus
  (headless, some sandboxes); idle inhibition also depends on the DE honoring the
  logind lock. Log and continue; never surface as a turn failure.
- **`sleep=false` is deliberate.** If the user closes the lid, let it sleep;
  keeping `idle` only means "don't idle-sleep while unattended and busy."
- **Linger tuning** (30s suggested) balances churn vs. keeping the machine up
  between rapid turns; make it a const.
- **Verify on real hardware.** Reasoning here is source-level; before closing the
  implementation ticket, confirm on at least macOS and Linux that a >idle-timeout
  turn does not sleep the machine, and that the guard releases after linger
  (check `pmset -g assertions` on macOS; `systemd-inhibit --list` on Linux).
- Not exercised in this spike: Windows Modern Standby machines, where
  `ES_AWAYMODE_REQUIRED` can't prevent sleep. We use `idle` not away-mode, so
  this is not a concern for our knobs, but note it.

## Suggested implementation checklist (for the follow-up ticket)

1. `keepawake = "0.6"` in `Cargo.toml` (pinned); version-bump note in `TODO.md`.
2. `SidecarManager::any_streaming()` in `sidecar.rs`.
3. `keep_awake.rs`: owner `std::thread` + poll + linger + best-effort error log;
   `idle=true, display=false, sleep=false`, reason/app-name/reverse-domain set.
4. Spawn it from `lib.rs setup` with the manager state.
5. Live-verify on macOS + Linux (assertions listed while busy, cleared after
   linger); commit with `HOY-188:` prefix and the verification evidence.
