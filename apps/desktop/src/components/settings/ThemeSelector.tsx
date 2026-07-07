import { Check, Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePrefsStore, type AppTheme } from "@/state/prefs";

const THEMES: Array<{
  value: AppTheme;
  label: string;
  description: string;
  icon: typeof Sun;
}> = [
  {
    value: "dark",
    label: "Dark",
    description: "Layered near-black workbench.",
    icon: Moon,
  },
  {
    value: "light",
    label: "Light",
    description: "Neutral light token set.",
    icon: Sun,
  },
  {
    value: "system",
    label: "System",
    description: "Follow the OS appearance.",
    icon: Monitor,
  },
];

export function ThemeSelector() {
  const theme = usePrefsStore((s) => s.theme);
  const setPref = usePrefsStore((s) => s.setPref);

  return (
    <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Theme">
      {THEMES.map((option) => {
        const Icon = option.icon;
        const selected = theme === option.value;
        return (
          <Button
            key={option.value}
            type="button"
            variant="outline"
            role="radio"
            aria-checked={selected}
            onClick={() => setPref("theme", option.value)}
            className={cn(
              "h-auto justify-start gap-3 p-3 text-left",
              selected && "border-brand/60 bg-brand/10 text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                {option.description}
              </span>
            </span>
            <Check
              className={cn(
                "size-4 shrink-0 text-brand",
                selected ? "opacity-100" : "opacity-0",
              )}
            />
          </Button>
        );
      })}
    </div>
  );
}
