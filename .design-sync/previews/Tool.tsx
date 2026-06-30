import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool";
import { CodeBlock } from "@/components/ai-elements/code-block";

export const EditDiff = () => (
  <Tool defaultOpen className="w-96 overflow-hidden rounded-md border border-border/70">
    <ToolHeader title="src/components/ThreadView.tsx" type="tool-edit" state="output-available" />
    <ToolContent className="border-t border-border/70">
      <CodeBlock
        code={"-  const port = 1420;\n+  const port = process.env.TAURI_DEV_PORT ?? 1420;"}
        language="diff"
        className="rounded-none border-0 bg-transparent"
      />
    </ToolContent>
  </Tool>
);

export const Running = () => (
  <Tool defaultOpen className="w-96 overflow-hidden rounded-md border border-border/70">
    <ToolHeader title="bash" type="tool-terminal" state="input-available" />
    <ToolContent className="border-t border-border/70">
      <div className="space-y-1 px-3 py-2 font-mono text-xs leading-relaxed">
        <div className="text-muted-foreground">
          <span className="text-brand">$</span> bun run check:ts
        </div>
      </div>
    </ToolContent>
  </Tool>
);

export const Error = () => (
  <Tool defaultOpen className="w-96 overflow-hidden rounded-md border border-border/70">
    <ToolHeader title="cargo check" type="tool-terminal" state="output-error" />
    <ToolContent className="border-t border-border/70">
      <pre className="overflow-x-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
        {"error[E0433]: failed to resolve: use of undeclared crate `pi_config`"}
      </pre>
    </ToolContent>
  </Tool>
);
