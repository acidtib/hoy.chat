import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";

export const Default = () => <Label htmlFor="thread-name">Thread name</Label>;

export const WithControl = () => (
  <div className="flex items-center gap-2">
    <Switch id="auto-approve" />
    <Label htmlFor="auto-approve">Auto-approve tool calls</Label>
  </div>
);

export const WithInput = () => (
  <div className="grid gap-1.5">
    <Label htmlFor="display-name">Display name</Label>
    <Input id="display-name" placeholder="Hoy" />
  </div>
);
