import { Shimmer } from "@/components/ai-elements/shimmer";

export const Default = () => <Shimmer>Thinking…</Shimmer>;

export const AsHeading = () => (
  <Shimmer as="h3" className="text-base font-medium">
    Generating response…
  </Shimmer>
);
