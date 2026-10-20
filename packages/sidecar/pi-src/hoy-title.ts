// HOY-370: the Title helper. A one-shot run of this binary (HOY_TITLE=1, like
// the goal evaluator) that names a thread from its first message on a cheap
// model. Prints {"title": string | null} and exits; any failure yields null so
// the thread keeps its first-line title.
import {
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pickModel } from "./hoy-goal-eval";

const MAX_INPUT_CHARS = 2000;
const MAX_TITLE_CHARS = 60;

export const TITLE_PROMPT = `You name conversations. Output only a title for the conversation that starts with the user's message, nothing else.

Rules:
- One line, at most 50 characters, in the language of the message.
- Name what the user wants to do, in natural words. Keep exact technical terms, file names, numbers, and error codes.
- Drop filler words like the, this, my, a, an. Do not start every title with the same verb.
- Never mention tools, never answer the message, never ask a question, and never say you cannot.
- For a greeting or small talk, name the intent, for example "Quick check-in".
- No quotes, no trailing period, no emojis.

Examples:
debug 500 errors in production -> Debugging production 500 errors
why is app.js failing -> app.js failure investigation
@src/credential.ts add refresh token support -> Credential refresh token support
how do I connect postgres to my API -> Postgres API connection
hello -> Greeting`;

// The model's reply as a usable title, or null.
export function cleanTitle(reply: string): string | null {
  const line = reply
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  let t = line
    .replace(/^title:\s*/i, "")
    .replace(/^["'`\u201c\u2018]+|["'`\u201d\u2019]+$/g, "")
    .replace(/[.\s]+$/, "")
    .replace(/\u2014/g, "-")
    .trim();
  if (!t) return null;
  if (t.length > MAX_TITLE_CHARS) t = `${t.slice(0, MAX_TITLE_CHARS - 3).trimEnd()}...`;
  return t;
}

function emit(title: string | null): never {
  process.stdout.write(JSON.stringify({ title }));
  process.exit(0);
}

export async function runTitle(agentDir: string, cwd: string): Promise<never> {
  try {
    const text = process.env.HOY_TITLE_TEXT?.trim().slice(0, MAX_INPUT_CHARS);
    if (!text) emit(null);
    const pinned = process.env.HOY_TITLE_MODEL?.trim();
    const slash = pinned ? pinned.indexOf("/") : -1;
    const threadModel = pinned && slash > 0 ? { provider: pinned.slice(0, slash), modelId: pinned.slice(slash + 1) } : null;

    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const registry = new ModelRegistry(modelRuntime);
    // The thread's model only seeds the provider choice: a cheap model from the
    // same provider wins, so a title never runs on an expensive model by default.
    const model = pickModel(registry, registry.getAvailable(), threadModel, "HOY_TITLE_PINNED_MODEL");
    if (!model) emit(null);
    console.error(`hoy-title: model=${model!.provider}/${model!.id}`);

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noContextFiles: true,
      systemPromptOverride: () => TITLE_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      model: model!,
      thinkingLevel: "off",
      modelRuntime,
      tools: [],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
    });
    try {
      session.setAutoCompactionEnabled(false);
      await session.prompt(`<message>\n${text}\n</message>`);
      emit(cleanTitle(session.getLastAssistantText() ?? ""));
    } finally {
      session.dispose();
    }
  } catch (e) {
    console.error(`hoy-title: ${e instanceof Error ? e.message : String(e)}`);
    emit(null);
  }
}
