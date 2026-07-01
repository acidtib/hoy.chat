import {
  Archive,
  Boxes,
  Brain,
  Cable,
  Info,
  LayoutGrid,
  MessageSquare,
  Mic,
  Network,
  Palette,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export type CategoryId =
  | "model"
  | "chat"
  | "appearance"
  | "workspace"
  | "safety"
  | "memory"
  | "voice"
  | "advanced"
  | "providers"
  | "gateway"
  | "tools"
  | "mcp"
  | "archived"
  | "about";

export interface Category {
  id: CategoryId;
  label: string;
  icon: LucideIcon;
  group: number;
}

// Mirrors the reference layout: three groups separated in the rail.
export const CATEGORIES: Category[] = [
  { id: "model", label: "Model", icon: Boxes, group: 0 },
  { id: "chat", label: "Chat", icon: MessageSquare, group: 0 },
  { id: "appearance", label: "Appearance", icon: Palette, group: 0 },
  { id: "workspace", label: "Workspace", icon: LayoutGrid, group: 0 },
  { id: "safety", label: "Safety", icon: ShieldCheck, group: 0 },
  { id: "memory", label: "Memory & Context", icon: Brain, group: 0 },
  { id: "voice", label: "Voice", icon: Mic, group: 0 },
  { id: "advanced", label: "Advanced", icon: SlidersHorizontal, group: 0 },
  { id: "providers", label: "Providers", icon: Plug, group: 1 },
  { id: "gateway", label: "Gateway", icon: Network, group: 1 },
  { id: "tools", label: "Tools & Keys", icon: Wrench, group: 1 },
  { id: "mcp", label: "MCP", icon: Cable, group: 1 },
  { id: "archived", label: "Archived Chats", icon: Archive, group: 1 },
  { id: "about", label: "About", icon: Info, group: 2 },
];
