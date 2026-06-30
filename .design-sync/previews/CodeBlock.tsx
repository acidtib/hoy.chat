import { CodeBlock } from "@/components/ai-elements/code-block";

export const TypeScript = () => (
  <CodeBlock
    code={`export function formatContext(n?: number | null): string | null {\n  if (!n) return null;\n  if (n >= 1_000_000) return \`\${n / 1_000_000}M\`;\n  return String(n);\n}`}
    language="typescript"
  />
);

export const Diff = () => (
  <CodeBlock
    code={`-  const port = 1420;\n+  const port = process.env.TAURI_DEV_PORT ?? 1420;`}
    language="diff"
  />
);

export const WithLineNumbers = () => (
  <CodeBlock
    code={`{\n  "name": "hoy-desktop",\n  "private": true,\n  "version": "0.1.1"\n}`}
    language="json"
    showLineNumbers
  />
);
