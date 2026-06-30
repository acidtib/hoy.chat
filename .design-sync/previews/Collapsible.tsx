import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";

export const Open = () => (
  <Collapsible open className="w-72">
    <CollapsibleTrigger asChild>
      <Button variant="ghost" size="sm" className="w-full justify-start">
        Reasoning (4s)
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent className="px-3 py-2 text-sm text-muted-foreground">
      The user wants a thread-history dropdown, so I should reuse the
      existing DropdownMenu primitive instead of building a new popover.
    </CollapsibleContent>
  </Collapsible>
);

export const Closed = () => (
  <Collapsible className="w-72">
    <CollapsibleTrigger asChild>
      <Button variant="ghost" size="sm" className="w-full justify-start">
        Reasoning (4s)
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent className="px-3 py-2 text-sm text-muted-foreground">
      Hidden until expanded.
    </CollapsibleContent>
  </Collapsible>
);
