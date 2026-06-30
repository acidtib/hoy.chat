import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";

export const Default = () => (
  <Conversation className="h-72 w-full max-w-md rounded-md border border-border">
    <ConversationContent className="gap-4 p-3">
      <Message from="user">
        <MessageContent>How do I rebuild the sidecar binary?</MessageContent>
      </Message>
      <Message from="assistant">
        <MessageContent>
          <MessageResponse>
            {"Run `sidecar/build.sh` whenever `sidecar/pi-src` changes, before any live verification."}
          </MessageResponse>
        </MessageContent>
      </Message>
    </ConversationContent>
    <ConversationScrollButton />
  </Conversation>
);
