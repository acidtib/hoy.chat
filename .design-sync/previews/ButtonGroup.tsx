import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupSeparator, ButtonGroupText } from "@/components/ui/button-group";

export const Horizontal = () => (
  <ButtonGroup>
    <Button variant="outline">Copy</Button>
    <Button variant="outline">Edit</Button>
    <Button variant="outline">Delete</Button>
  </ButtonGroup>
);

export const WithSeparatorAndLabel = () => (
  <ButtonGroup>
    <ButtonGroupText>Model</ButtonGroupText>
    <ButtonGroupSeparator />
    <Button variant="outline">Sonnet</Button>
    <Button variant="outline">Opus</Button>
  </ButtonGroup>
);

export const Vertical = () => (
  <ButtonGroup orientation="vertical" className="w-40">
    <Button variant="outline">Archive</Button>
    <Button variant="outline">Rename</Button>
    <Button variant="outline">Delete</Button>
  </ButtonGroup>
);
