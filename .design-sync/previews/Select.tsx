import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PROVIDERS = ["anthropic", "openai", "google"];

export const Closed = () => (
  <Select value="anthropic">
    <SelectTrigger className="w-56">
      <SelectValue placeholder="Provider" />
    </SelectTrigger>
    <SelectContent>
      {PROVIDERS.map((p) => (
        <SelectItem key={p} value={p}>
          {p}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

export const Open = () => (
  <Select value="anthropic" open>
    <SelectTrigger className="w-56">
      <SelectValue placeholder="Provider" />
    </SelectTrigger>
    <SelectContent>
      {PROVIDERS.map((p) => (
        <SelectItem key={p} value={p}>
          {p}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);
