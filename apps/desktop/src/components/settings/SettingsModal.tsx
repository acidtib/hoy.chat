import { useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useSessionStore } from "@/state/store";
import { CATEGORIES, type CategoryId } from "./categories";
import { SettingsPanel } from "./panels";

export function SettingsModal() {
  const open = useSessionStore((s) => s.settingsOpen);
  const setOpen = useSessionStore((s) => s.setSettingsOpen);
  const [active, setActive] = useState<CategoryId>("model");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[88vh] w-[92vw] max-w-[1080px] flex-row gap-0 overflow-hidden p-0 sm:max-w-[1080px]">
        <DialogTitle className="sr-only">Settings</DialogTitle>

        <nav className="flex w-56 shrink-0 flex-col border-r border-border bg-background/40">
          <div className="scrollbar-thin flex-1 overflow-y-auto p-2">
            {CATEGORIES.map((cat, i) => {
              const prev = CATEGORIES[i - 1];
              const Icon = cat.icon;
              return (
                <div key={cat.id}>
                  {prev && prev.group !== cat.group && (
                    <Separator className="my-2" />
                  )}
                  <button
                    type="button"
                    onClick={() => setActive(cat.id)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                      active === cat.id
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="truncate">{cat.label}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </nav>

        <div className="scrollbar-thin min-w-0 flex-1 overflow-y-auto">
          <div className="w-full max-w-4xl px-8 py-8">
            <SettingsPanel id={active} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
