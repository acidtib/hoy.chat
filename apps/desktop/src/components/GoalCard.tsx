import { useEffect, useState } from "react";
import { CircleCheck, Hourglass, Pause, Play, Target, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/state/store";
import type { ThreadGoal } from "@/state/goal";
import { formatElapsed, formatTokens } from "@/lib/utils";

// Goal Mode (HOY-263): status card for a thread's active/paused/settled goal.
// Mounted by ThreadView near the composer whenever thread.goal is set. Reads
// pauseGoal/resumeGoal/clearGoal straight from the store (Task 4) so ThreadView
// only has to pass threadId + goal, mirroring how other footer widgets in this
// file are wired.
//
// HOY-258 (a persistent "working" indicator) is a sibling ticket and is not
// merged as of this task -- there is nothing in ThreadView to reconcile with,
// so this card ships its own compact active indicator (pulsing dot) rather
// than folding into a shared surface. If HOY-258 lands later, that indicator
// should learn to read "working toward goal" when a goal is active instead of
// this card growing a second one.

const STATUS_LABEL: Record<ThreadGoal["status"], string> = {
  active: "Active",
  paused: "Paused",
  met: "Met",
  capped: "Capped",
  cleared: "Cleared",
};

export function GoalCard({
  threadId,
  goal,
}: {
  threadId: string;
  goal: ThreadGoal;
}) {
  const pauseGoal = useSessionStore((s) => s.pauseGoal);
  const resumeGoal = useSessionStore((s) => s.resumeGoal);
  const clearGoal = useSessionStore((s) => s.clearGoal);

  const isActive = goal.status === "active";

  // Single interval, only while active: ticks a re-render every second so
  // elapsed stays live. Cleaned up on unmount and whenever isActive flips
  // false (status change), so a paused/met/capped/cleared card never carries
  // a running timer.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Freeze `now` at the exact moment status stops being active (mount in a
    // settled state included), so met/capped/paused cards show a fixed elapsed
    // reading with no running timer, matching store.ts's own /goal status
    // notice (`formatElapsed(Date.now() - goal.startedAt)`).
    setNow(Date.now());
    if (!isActive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  const elapsed = formatElapsed(now - goal.startedAt);
  const canResume = goal.status === "paused" || goal.status === "capped";
  // Only "met" and "cleared" are terminal: they hide the Pause/Resume block
  // entirely. "paused" and "capped" both render as Resume-enabled (Resume
  // supports resuming from either), matching the design doc's "Resume from
  // paused/capped re-arms and sends a continuation".
  const isSettled = goal.status === "met" || goal.status === "cleared";

  return (
    <div className="mx-3 mb-2 shrink-0 rounded-lg border border-brand/40 bg-card/70 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <Target className="mt-0.5 size-4 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-brand">
              Goal
            </span>
            <GoalStatusBadge status={goal.status} />
          </div>
          <div className="mt-1 text-xs leading-relaxed text-foreground">
            {goal.condition}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
            <span>{elapsed}</span>
            <span>
              turn {goal.turns}/{goal.capTurns}
            </span>
            <span>{formatTokens(goal.tokensUsed)} tokens</span>
          </div>
          {goal.verifyCommand && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span className="min-w-0 truncate font-mono">
                verify: {goal.verifyCommand}
              </span>
              {goal.lastVerifyExit !== undefined && (
                <span
                  className={
                    goal.lastVerifyExit === 0
                      ? "font-mono text-emerald-500"
                      : "font-mono text-destructive"
                  }
                >
                  exit {goal.lastVerifyExit}
                </span>
              )}
            </div>
          )}
          {/* HOY-299: mark a goal that is checked by the independent read-only
              auditor, matching the verify metadata treatment above. Absent or
              "transcript" (v1/v2) renders nothing. */}
          {goal.evaluatorKind === "auditor" && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span className="font-mono">auditor</span>
            </div>
          )}
          {goal.lastReason && (
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {goal.lastReason}
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end gap-1.5">
        {!isSettled &&
          (isActive ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => pauseGoal(threadId)}
            >
              <Pause className="size-3.5" />
              Pause
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 border-brand/40 text-xs text-brand hover:text-brand"
              onClick={() => void resumeGoal(threadId)}
              disabled={!canResume}
            >
              <Play className="size-3.5" />
              Resume
            </Button>
          ))}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground hover:text-destructive"
          onClick={() => clearGoal(threadId)}
        >
          <Trash2 className="size-3.5" />
          Clear
        </Button>
      </div>
    </div>
  );
}

function GoalStatusBadge({ status }: { status: ThreadGoal["status"] }) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <span
          className="size-1.5 shrink-0 rounded-full bg-brand animate-pulse motion-reduce:animate-none"
          aria-hidden
        />
        {STATUS_LABEL[status]}
      </span>
    );
  }
  const Icon = status === "met" ? CircleCheck : Hourglass;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <Icon className="size-3 shrink-0" />
      {STATUS_LABEL[status]}
    </span>
  );
}
