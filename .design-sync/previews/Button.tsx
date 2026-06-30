import { Button } from "@/components/ui/button";

export const Variants = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Button variant="default">Send</Button>
    <Button variant="outline">Cancel</Button>
    <Button variant="secondary">New thread</Button>
    <Button variant="ghost">Settings</Button>
    <Button variant="destructive">Delete</Button>
    <Button variant="link">Learn more</Button>
  </div>
);

export const Sizes = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Button size="xs">Extra small</Button>
    <Button size="sm">Small</Button>
    <Button size="default">Default</Button>
    <Button size="lg">Large</Button>
    <Button size="icon" aria-label="Send">
      ↑
    </Button>
  </div>
);

export const Disabled = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Button disabled>Send</Button>
    <Button variant="outline" disabled>
      Cancel
    </Button>
  </div>
);
