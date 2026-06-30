import { Badge } from "@/components/ui/badge";

export const Variants = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Badge>Default</Badge>
    <Badge variant="secondary">Secondary</Badge>
    <Badge variant="outline">Outline</Badge>
    <Badge variant="ghost">Ghost</Badge>
    <Badge variant="destructive">Error</Badge>
    <Badge variant="link">Link</Badge>
  </div>
);

export const StatusUse = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Badge variant="secondary">Completed</Badge>
    <Badge variant="outline">Running</Badge>
    <Badge variant="destructive">Error</Badge>
  </div>
);
