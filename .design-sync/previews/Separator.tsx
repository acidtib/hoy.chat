import { Separator } from "@/components/ui/separator";

export const Horizontal = () => (
  <div className="w-64">
    <div className="text-sm">Provider settings</div>
    <Separator className="my-3" />
    <div className="text-sm text-muted-foreground">API key</div>
  </div>
);

export const Vertical = () => (
  <div className="flex h-8 items-center gap-3 text-sm">
    <span>New thread</span>
    <Separator orientation="vertical" />
    <span>Settings</span>
    <Separator orientation="vertical" />
    <span>Close</span>
  </div>
);
