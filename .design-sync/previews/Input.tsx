import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Default = () => (
  <Input placeholder="Search models..." className="max-w-sm" />
);

export const WithLabel = () => (
  <div className="grid w-full max-w-sm gap-1.5">
    <Label htmlFor="api-key">API key</Label>
    <Input id="api-key" type="password" placeholder="sk-ant-..." />
  </div>
);

export const Disabled = () => (
  <Input placeholder="No models available" disabled className="max-w-sm" />
);
