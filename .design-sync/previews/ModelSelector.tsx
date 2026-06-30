import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
} from "@/components/ai-elements/model-selector";

export const Open = () => (
  <ModelSelector open>
    <ModelSelectorContent title="Select a model">
      <ModelSelectorInput placeholder="Search models..." />
      <ModelSelectorList>
        <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
        <ModelSelectorGroup heading="anthropic">
          <ModelSelectorItem value="claude-opus-4-8">
            <span className="flex-1 truncate">Claude Opus 4.8</span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              200K
            </span>
          </ModelSelectorItem>
          <ModelSelectorItem value="claude-sonnet-5">
            <span className="flex-1 truncate">Claude Sonnet 5</span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              200K
            </span>
          </ModelSelectorItem>
        </ModelSelectorGroup>
        <ModelSelectorGroup heading="openai">
          <ModelSelectorItem value="gpt-5-1">
            <span className="flex-1 truncate">GPT-5.1</span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              400K
            </span>
          </ModelSelectorItem>
        </ModelSelectorGroup>
      </ModelSelectorList>
    </ModelSelectorContent>
  </ModelSelector>
);
