import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";

export const Open = () => (
  <Reasoning open isStreaming={false} duration={4} className="w-80">
    <ReasoningTrigger />
    <ReasoningContent>
      The user wants a thread-history dropdown, so I should reuse the
      existing DropdownMenu primitive instead of building a new popover.
    </ReasoningContent>
  </Reasoning>
);

export const Streaming = () => (
  <Reasoning open isStreaming className="w-80">
    <ReasoningTrigger />
    <ReasoningContent>
      Checking how `sidecar.rs` passes `PI_CODING_AGENT_DIR` to the
      sidecar process...
    </ReasoningContent>
  </Reasoning>
);
