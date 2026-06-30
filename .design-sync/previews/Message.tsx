import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";

export const UserMessage = () => (
  <Message from="user">
    <MessageContent>
      Refactor `ThreadView.tsx` to extract the tool-call rendering into its
      own component.
    </MessageContent>
  </Message>
);

export const AssistantMessage = () => (
  <Message from="assistant">
    <MessageContent>
      <MessageResponse>
        {"I'll extract `ToolCall` into its own file under `src/components/`.\n\n- Move the `toolKind`/`toolIcon` helpers alongside it\n- Keep the import in `ThreadView.tsx` unchanged"}
      </MessageResponse>
    </MessageContent>
  </Message>
);

export const Thread = () => (
  <div className="flex w-full max-w-md flex-col gap-4">
    <Message from="user">
      <MessageContent>What does the JSONL framing bug look like?</MessageContent>
    </Message>
    <Message from="assistant">
      <MessageContent>
        <MessageResponse>
          {"U+2028 and U+2029 are valid inside JSON strings but split lines if you read on Unicode separators instead of `\\n`."}
        </MessageResponse>
      </MessageContent>
    </Message>
  </div>
);
