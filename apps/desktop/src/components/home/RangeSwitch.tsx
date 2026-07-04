import { cn } from "@/lib/utils";
import type { UsageRange } from "@/lib/usage";

const OPTIONS: { value: UsageRange; label: string }[] = [
  { value: "all", label: "All Time" },
  { value: "30d", label: "30 Days" },
  { value: "7d", label: "7 Days" },
];

export function RangeSwitch({
  value,
  onChange,
}: {
  value: UsageRange;
  onChange: (r: UsageRange) => void;
}) {
  return (
    <div className="inline-flex divide-x divide-border border border-border">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "px-2.5 py-1 text-xs transition-colors",
            value === o.value
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
