import { useEffect, useState } from "react";
import { CircleCheck, Hourglass, Pause, Play, Target, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/state/store";
import type { ThreadGoal } from "@/state/goal";
import { formatTokens } from "@/lib/utils";

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

// Mirrors store.ts's private formatElapsed (used for the /goal status notice)
// but takes a live "now" so the card can tick every second while active.
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${minutes % 60}m`;
}

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
  const isSettled =
    goal.status === "met" || goal.status === "capped" || goal.status === "cleared";

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
