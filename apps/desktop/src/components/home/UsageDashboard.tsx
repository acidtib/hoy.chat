import { useEffect, useMemo, useState } from "react";
import { useSessionStore } from "@/state/store";
import {
  daysInRange,
  modelRanking,
  peakHour,
  streaks,
  totals,
  type UsageRange,
} from "@/lib/usage";
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
      totals: totals(days),
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
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-foreground">Usage</h2>
        <RangeSwitch value={range} onChange={setRange} />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Tokens" value={formatTokens(v.totals.tokens)} />
        <StatCard label="Sessions" value={String(v.totals.sessions)} />
        <StatCard label="Messages" value={String(v.totals.messages)} />
        <StatCard label="Active days" value={String(v.totals.activeDays)} />
        <StatCard
          label="Current streak"
          value={`${v.streaks.current}d`}
          sub={`Longest ${v.streaks.longest}d`}
        />
        <StatCard label="Peak hour" value={v.peak != null ? formatHour(v.peak) : "-"} />
      </div>

      <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Daily tokens</p>
          <TokenTrendChart days={v.days} />
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Models</p>
          <ModelRanking rows={v.models} />
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Activity</p>
        <ActivityHeatmap days={report.days} />
      </div>
    </section>
  );
}

function formatHour(h: number): string {
  const period = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${period}`;
}
