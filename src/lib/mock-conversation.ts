// Mock transcript driving the thread view until streaming AgentEvents land in
// M3. Shaped to exercise every conversation block: user/assistant messages,
// reasoning, and the tool-call kinds Zed distinguishes (read = bare row,
// edit/execute = card).

// The seeded thread that carries this mock history. Every other thread (a newly
// started one) opens empty, which drives the Zed-style full-panel composer.
export const SEEDED_THREAD_ID = "t_hoy_1";

export function getMockTurns(threadId: string | null): MockTurn[] {
  return threadId === SEEDED_THREAD_ID ? MOCK_TURNS : [];
}

export interface MockTool {
  name: string;
  title: string;
  // Edit tools carry a unified diff; execute tools carry the command line. Both
  // render as cards. Everything else (read/search) renders as a bare row with
  // its `output` shown on expand.
  diff?: string;
  command?: string;
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
        title: "src/lib/utils.ts",
        diff: "+export function formatRelativeTime(epochMs: number, now = Date.now()): string {\n+  const s = Math.max(0, Math.round((now - epochMs) / 1000));\n+  if (s < 60) return \"now\";\n+  const m = Math.floor(s / 60);\n+  if (m < 60) return `${m}m`;\n+  const h = Math.floor(m / 60);\n+  if (h < 24) return `${h}h`;\n+  const d = Math.floor(h / 24);\n+  if (d < 7) return `${d}d`;\n+  return `${Math.floor(d / 7)}w`;\n+}",
        output: "Applied 1 edit to src/lib/utils.ts (+11 lines)",
      },
      {
        name: "edit_file",
        title: "src/components/Sidebar.tsx",
        diff: "-        <span>{thread.updatedAt}</span>\n+        <span>{formatRelativeTime(thread.updatedAt)}</span>",
        output: "Applied 1 edit to src/components/Sidebar.tsx (+1 -1)",
      },
      {
        name: "run_terminal",
        title: "bun run build",
        command: "bun run build",
        output:
          "vite v7.3.5 building for production...\n✓ 312 modules transformed.\ndist/index.html                   0.46 kB\ndist/assets/index-D8reRRKd.js 1,379.33 kB\n✓ built in 7.81s",
      },
    ],
    text: "Done. Here's what changed:\n\n- Added **`formatRelativeTime`** to `src/lib/utils.ts`. It rounds the delta and steps through `now` -> `m` -> `h` -> `d` -> `w`, so a thread touched three weeks ago reads `3w`.\n- Wired it into `ThreadRow` in the sidebar, replacing the raw epoch.\n\n```ts\nformatRelativeTime(Date.now() - 3 * 7 * 24 * 60 * 60 * 1000); // \"3w\"\n```\n\nWant me to extend it past weeks into months and years, or add a tooltip with the absolute time on hover?",
  },
];
