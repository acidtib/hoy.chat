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
  | "workspace"
  | "memory"
  | "providers"
  | "about"
  | "appearance"
  | "safety"
  | "voice"
  | "advanced"
  | "gateway"
  | "tools"
  | "mcp"
  | "archived";

export interface Category {
  id: CategoryId;
  label: string;
  icon: LucideIcon;
  group: number;
  // Not backed by Pi RPC or a local pref yet; shown as an honest "Not available
  // yet" panel and grouped under "Coming soon" so the rail leads with what works.
  placeholder?: boolean;
}

// The rail leads with categories that actually do something (real prefs or Pi
// session settings), then a "Coming soon" group of honest placeholders.
export const CATEGORIES: Category[] = [
  { id: "model", label: "Model", icon: Boxes, group: 0 },
  { id: "chat", label: "Chat", icon: MessageSquare, group: 0 },
  { id: "workspace", label: "Workspace", icon: LayoutGrid, group: 0 },
  { id: "memory", label: "Memory & Context", icon: Brain, group: 0 },
  { id: "providers", label: "Providers", icon: Plug, group: 1 },
  { id: "about", label: "About", icon: Info, group: 1 },
  { id: "appearance", label: "Appearance", icon: Palette, group: 2, placeholder: true },
  { id: "safety", label: "Safety", icon: ShieldCheck, group: 2, placeholder: true },
  { id: "voice", label: "Voice", icon: Mic, group: 2, placeholder: true },
  { id: "advanced", label: "Advanced", icon: SlidersHorizontal, group: 2, placeholder: true },
  { id: "gateway", label: "Gateway", icon: Network, group: 2, placeholder: true },
  { id: "tools", label: "Tools & Keys", icon: Wrench, group: 2, placeholder: true },
  { id: "mcp", label: "MCP", icon: Cable, group: 2, placeholder: true },
  { id: "archived", label: "Archived Chats", icon: Archive, group: 2, placeholder: true },
];
