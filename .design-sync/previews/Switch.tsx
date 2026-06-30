import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

export const States = () => (
  <div className="flex flex-col gap-3">
    <div className="flex items-center gap-2">
      <Switch id="s-off" />
      <Label htmlFor="s-off">Off</Label>
    </div>
    <div className="flex items-center gap-2">
      <Switch id="s-on" defaultChecked />
      <Label htmlFor="s-on">On</Label>
    </div>
    <div className="flex items-center gap-2">
      <Switch id="s-disabled" disabled />
      <Label htmlFor="s-disabled">Disabled</Label>
    </div>
  </div>
);
