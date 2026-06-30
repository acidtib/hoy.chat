import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";

export const WithButton = () => (
  <InputGroup className="max-w-sm">
    <InputGroupInput placeholder="Search models..." />
    <InputGroupAddon align="inline-end">
      <InputGroupButton size="icon-xs" aria-label="Clear">
        ×
      </InputGroupButton>
    </InputGroupAddon>
  </InputGroup>
);

export const WithLeadingText = () => (
  <InputGroup className="max-w-sm">
    <InputGroupAddon align="inline-start">
      <InputGroupText>$</InputGroupText>
    </InputGroupAddon>
    <InputGroupInput placeholder="0.00" />
  </InputGroup>
);
