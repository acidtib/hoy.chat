import { Settings, Sparkle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function HomePage({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-background">
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute right-3 top-3 text-muted-foreground"
        onClick={onOpenSettings}
        aria-label="Settings"
      >
        <Settings className="size-4" />
      </Button>

      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-10">
        <div className="flex items-center gap-2 pt-10">
          <Sparkle className="size-5 text-brand" />
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            What&rsquo;s up next?
          </h1>
        </div>
      </div>
    </div>
  );
}
