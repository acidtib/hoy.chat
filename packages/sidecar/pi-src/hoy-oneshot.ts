// One tool-less prompt on a cheap model, shared by the hidden helpers (Title,
// HOY-370; Dispatcher, HOY-353).
import {
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

type PickableModel = { provider: string; id: string; cost?: { input: number; output: number } };

// HOY_DISABLED_MODELS: newline-separated "provider/id" keys the user switched off.
export function disabledModels(env = process.env.HOY_DISABLED_MODELS): Set<string> {
  return new Set((env ?? "").split("\n").map((k) => k.trim()).filter(Boolean));
}

const price = (m: PickableModel) => (m.cost?.input ?? 0) + (m.cost?.output ?? 0);

// `pinned` is used exactly; a `seed` only narrows to its provider. Either way the
// lowest catalog price wins, and disabled models are never picked.
export function pickOneShotModel<M extends PickableModel>(
  available: M[],
  opts: { pinned?: string; seed?: string; disabled?: Set<string> },
): M | undefined {
  const key = (m: M) => `${m.provider}/${m.id}`;
  const enabled = available.filter((m) => !opts.disabled?.has(key(m)));
  const pinned = opts.pinned?.trim();
  const exact = pinned ? enabled.find((m) => key(m) === pinned) : undefined;
  if (exact) return exact;
  const cheapest = (list: M[]) =>
    list.reduce<M | undefined>((best, m) => (!best || price(m) < price(best) ? m : best), undefined);
  const provider = opts.seed?.trim().split("/")[0];
  return (provider && cheapest(enabled.filter((m) => m.provider === provider))) || cheapest(enabled);
}

export async function runOneShot(opts: {
  agentDir: string;
  cwd: string;
  systemPrompt: string;
  prompt: string;
  pinned?: string;
  seed?: string;
  tag: string;
}): Promise<{ text: string; cost: number; model: string } | null> {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(opts.agentDir, "auth.json"),
    modelsPath: join(opts.agentDir, "models.json"),
  });
  const registry = new ModelRegistry(modelRuntime);
  const model = pickOneShotModel(registry.getAvailable(), {
    pinned: opts.pinned,
    seed: opts.seed,
    disabled: disabledModels(),
  });
  if (!model) return null;
  console.error(`${opts.tag}: model=${model.provider}/${model.id}`);
  const loader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    noContextFiles: true,
    systemPromptOverride: () => opts.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    modelRuntime,
    tools: [],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(opts.cwd),
  });
  try {
    session.setAutoCompactionEnabled(false);
    await session.prompt(opts.prompt);
    return {
      text: session.getLastAssistantText() ?? "",
      cost: session.getSessionStats().cost ?? 0,
      model: `${model.provider}/${model.id}`,
    };
  } finally {
    session.dispose();
  }
}
