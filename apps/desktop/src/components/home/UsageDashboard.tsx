import { useEffect, useMemo, useState } from "react";
import { useSessionStore } from "@/state/store";
import {
  daysInRange,
  modelBreakdown,
  peakHour,
  streaks,
  totals,
  type UsageRange,
} from "@/lib/usage";
import { formatTokens } from "@/lib/utils";
import { StatCard } from "./StatCard";
import { RangeSwitch } from "./RangeSwitch";
import { ModelUsage } from "./ModelUsage";
import { TokenTrendChart } from "./TokenTrendChart";
import { ActivityHeatmap, HeatmapLegend } from "./ActivityHeatmap";

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
    // The cards, heatmap, and streak are an all-time summary; only the charts
    // below (trend + model usage) respond to the range switch.
    const rangeDays = daysInRange(report.days, range);
    return {
      totals: totals(report.days),
      streaks: streaks(report.days),
      peak: peakHour(report.days),
      rangeDays,
      breakdown: modelBreakdown(rangeDays),
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
    <section className="space-y-8">
      <h2 className="text-sm font-medium text-foreground">Usage Stats</h2>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Token Usage" value={formatTokens(v.totals.tokens)} />
        <StatCard label="Threads" value={String(v.totals.sessions)} />
        <StatCard label="Messages" value={String(v.totals.messages)} />
        <StatCard label="Active Days" value={String(v.totals.activeDays)} />
        <StatCard
          label="Current Streak"
          value={`${v.streaks.current}d`}
          sub={`Longest ${v.streaks.longest}d`}
        />
        <StatCard label="Peak Hour" value={v.peak != null ? formatHour(v.peak) : "-"} />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground">Activity Heatmap</h3>
          <HeatmapLegend />
        </div>
        <ActivityHeatmap days={report.days} />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground">Daily Token Trend</h3>
          <RangeSwitch value={range} onChange={setRange} />
        </div>
        <TokenTrendChart days={v.rangeDays} breakdown={v.breakdown} />
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">Model Usage</h3>
        <ModelUsage ranked={v.breakdown.ranked} total={v.breakdown.total} />
      </div>
    </section>
  );
}

function formatHour(h: number): string {
  const period = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${period}`;
}
