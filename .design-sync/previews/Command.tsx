import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

export const Default = () => (
  <Command className="w-72 rounded-lg border border-border">
    <CommandInput placeholder="Search models..." />
    <CommandList>
      <CommandEmpty>No models found.</CommandEmpty>
      <CommandGroup heading="anthropic">
        <CommandItem>Claude Opus 4.8</CommandItem>
        <CommandItem>Claude Sonnet 5</CommandItem>
        <CommandItem>Claude Haiku 4.5</CommandItem>
      </CommandGroup>
      <CommandGroup heading="openai">
        <CommandItem>GPT-5.1</CommandItem>
      </CommandGroup>
    </CommandList>
  </Command>
);
