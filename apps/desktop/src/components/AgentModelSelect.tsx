import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { modelKey } from "@/lib/models";
import type { ModelInfo } from "@/lib/types";

const DEFAULT_MODEL = "__default__";

// HOY-368: the model an agent runs on. "Default" follows the app's default model.
export function AgentModelSelect({
  value,
  models,
  disabled,
  onChange,
}: {
  value: string | null;
  models: ModelInfo[];
  disabled?: boolean;
  onChange: (model: string | null) => void;
}) {
  const known = value ? models.some((m) => modelKey(m) === value) : true;
  return (
    <Select
      value={value ?? DEFAULT_MODEL}
      disabled={disabled}
      onValueChange={(v) => onChange(v === DEFAULT_MODEL ? null : v)}
    >
      <SelectTrigger size="sm" className="h-7 w-44 cursor-pointer text-xs" aria-label="Model">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="scrollbar-thin max-h-[50vh]">
        <SelectItem value={DEFAULT_MODEL}>Default model</SelectItem>
        {!known && value && <SelectItem value={value}>{value}</SelectItem>}
        {models.map((m) => (
          <SelectItem key={modelKey(m)} value={modelKey(m)}>
            {m.name || m.id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

