import { Textarea } from "@/components/ui/textarea";

export const Default = () => (
  <Textarea placeholder="Ask Hoy to do something..." className="max-w-sm" />
);

export const WithValue = () => (
  <Textarea
    defaultValue={"Refactor src/components/ThreadView.tsx to extract\nthe tool-call rendering into its own component."}
    className="max-w-sm"
    rows={4}
  />
);

export const Disabled = () => (
  <Textarea placeholder="Streaming..." disabled className="max-w-sm" />
);
