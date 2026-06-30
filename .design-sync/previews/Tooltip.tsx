import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const Default = () => (
  <Tooltip open>
    <TooltipTrigger asChild>
      <Button variant="ghost" size="icon" aria-label="New thread">
        +
      </Button>
    </TooltipTrigger>
    <TooltipContent>New thread</TooltipContent>
  </Tooltip>
);
