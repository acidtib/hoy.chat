// Safety rails for recursive subagents (HOY-245). Named constants, not
// settings-UI knobs: a user-tunable depth would defeat the fork-bomb guard.
// The sidecar keeps its own MAX_SUBAGENT_DEPTH (packages/sidecar/pi-src/
// hoy-sidecar.ts) as the authoritative structural gate; keep the two in sync.

// A thread at depth d may spawn a child iff d < MAX_SUBAGENT_DEPTH. Root user
// thread is depth 0, so the deepest agent is depth 3 and cannot spawn.
export const MAX_SUBAGENT_DEPTH = 3;

// At most this many subagent initial runs stream at once; the rest queue.
// Foreground (user) turns and resume-on-delivery runs are exempt.
export const MAX_CONCURRENT_AGENTS = 4;
