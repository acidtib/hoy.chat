// Mock transcript driving the thread view until streaming AgentEvents land in
// M3. Shaped to exercise every AI Elements block: user/assistant messages,
// reasoning, and tool calls with input/output.

export interface MockTool {
  name: string;
  title: string;
  input: unknown;
  output: string;
}

export type MockTurn =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      reasoning?: { text: string; seconds: number };
      tools?: MockTool[];
      text?: string;
    };

export const MOCK_TURNS: MockTurn[] = [
  {
    role: "user",
    text: "The sidebar shows raw timestamps next to each thread. Can you make them relative, like \"3w\" or \"2h\"?",
  },
  {
    role: "assistant",
    reasoning: {
      seconds: 6,
      text: "The thread rows render `updatedAt` directly. I should add a small formatter that converts an epoch to a compact relative label, then use it in the sidebar. Let me read the existing utils to match the style before adding anything.",
    },
    tools: [
      {
        name: "read_file",
        title: "Read src/lib/utils.ts",
        input: { path: "src/lib/utils.ts" },
        output:
          'import { clsx, type ClassValue } from "clsx";\nimport { twMerge } from "tailwind-merge";\n\nexport function cn(...inputs: ClassValue[]) {\n  return twMerge(clsx(inputs));\n}',
      },
    ],
    text: "There's no time helper yet, just `cn`. I'll add a `formatRelativeTime` next to it that buckets the delta into seconds, minutes, hours, days, weeks, months, and years.",
  },
  {
    role: "assistant",
    tools: [
      {
        name: "edit_file",
        title: "Edit src/lib/utils.ts",
        input: {
          path: "src/lib/utils.ts",
          diff: "+ export function formatRelativeTime(epochMs: number, now = Date.now()): string {\n+   const s = Math.max(0, Math.round((now - epochMs) / 1000));\n+   if (s < 60) return \"now\";\n+   const m = Math.floor(s / 60);\n+   if (m < 60) return `${m}m`;\n+   const h = Math.floor(m / 60);\n+   if (h < 24) return `${h}h`;\n+   const d = Math.floor(h / 24);\n+   if (d < 7) return `${d}d`;\n+   return `${Math.floor(d / 7)}w`;\n+ }",
        },
        output: "Applied 1 edit to src/lib/utils.ts (+11 lines)",
      },
      {
        name: "edit_file",
        title: "Edit src/components/Sidebar.tsx",
        input: {
          path: "src/components/Sidebar.tsx",
          diff: '- <span>{thread.updatedAt}</span>\n+ <span>{formatRelativeTime(thread.updatedAt)}</span>',
        },
        output: "Applied 1 edit to src/components/Sidebar.tsx (+1 -1)",
      },
    ],
    text: "Done. Here's what changed:\n\n- Added **`formatRelativeTime`** to `src/lib/utils.ts`. It rounds the delta and steps through `now` -> `m` -> `h` -> `d` -> `w`, so a thread touched three weeks ago reads `3w`.\n- Wired it into `ThreadRow` in the sidebar, replacing the raw epoch.\n\n```ts\nformatRelativeTime(Date.now() - 3 * 7 * 24 * 60 * 60 * 1000); // \"3w\"\n```\n\nWant me to extend it past weeks into months and years, or add a tooltip with the absolute time on hover?",
  },
];
