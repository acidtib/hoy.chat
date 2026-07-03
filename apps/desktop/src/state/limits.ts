// Safety rails for recursive subagents (HOY-245). The depth cap stays a hard
// constant, not a settings-UI knob: a user-tunable depth would defeat the
// fork-bomb guard. The sidecar keeps its own MAX_SUBAGENT_DEPTH
// (packages/sidecar/pi-src/hoy-sidecar.ts) as the authoritative structural
// gate; keep the two in sync.

// A thread at depth d may spawn a child iff d < MAX_SUBAGENT_DEPTH. Root user
// thread is depth 0, so the deepest agent is depth 3 and cannot spawn.
export const MAX_SUBAGENT_DEPTH = 3;

// Default for the maxConcurrentAgents pref (HOY-247): at most this many subagent
// initial runs stream at once; the rest queue. Foreground (user) turns and
// resume-on-delivery runs are exempt. Unlike depth, concurrency is safe to tune
// (the excess just queues), so the live value is a renderer pref seeded here.
export const MAX_CONCURRENT_AGENTS = 4;
