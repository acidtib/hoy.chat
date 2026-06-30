import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

export const Open = () => (
  <DropdownMenu open>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="icon-sm" aria-label="Thread options">
        ⋯
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="min-w-40">
      <DropdownMenuLabel>Thread</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem>Archive</DropdownMenuItem>
      <DropdownMenuItem>Rename</DropdownMenuItem>
      <DropdownMenuItem variant="destructive">
        Delete permanently
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);
