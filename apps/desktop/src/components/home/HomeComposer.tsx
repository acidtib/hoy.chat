import { useCallback, useEffect, useMemo, useState } from "react";
import { Composer } from "@/components/Composer";
import { useSessionStore } from "@/state/store";
import { listProjectPaths } from "@/lib/ipc";
import { fileToImageAttachment } from "@/lib/images";
import { modelSupportsImages } from "@/lib/types";
import type {
  ImageAttachment,
  ModelRef,
  PermissionMode,
  ThinkingLevel,
} from "@/lib/types";

// The hero composer on home (HOY-264). Reuses the real Composer, but holds its
// draft/model/permission/thinking/attachments in LOCAL state so no thread is
// created until submit. On submit it hands off to startThread (create-and-send).
export function HomeComposer({
  projectId,
  projectPath,
}: {
  projectId: string;
  projectPath: string | null;
}) {
  const models = useSessionStore((s) => s.models);
  const defaultModel = useSessionStore((s) => s.defaultModel);
  const projects = useSessionStore((s) => s.projects);
  const startThread = useSessionStore((s) => s.startThread);
  // Skills for the "/" and "@skill:" pickers (HOY-323). No thread exists yet, so
  // there is no session and thus no get_commands; skills come from disk instead,
  // refreshed for the selected project like ThreadView does.
  const skillCommands = useSessionStore((s) => s.skillCommands);
  const refreshSkills = useSessionStore((s) => s.refreshSkills);

  useEffect(() => {
    void refreshSkills(projectPath);
  }, [projectPath, refreshSkills]);

  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [model, setModel] = useState<ModelRef | null>(null);
  const [mode, setMode] = useState<PermissionMode>("default");
  const [thinking, setThinking] = useState<ThinkingLevel>("high");

  const currentModel = model ?? defaultModel;
  const activeModel = currentModel
    ? models.find(
        (m) => m.provider === currentModel.provider && m.id === currentModel.id,
      ) ?? null
    : null;
  const canAttachImages = modelSupportsImages(activeModel);

  const searchPaths = useCallback(
    (query: string) =>
      projectPath ? listProjectPaths(projectPath, query, 50) : Promise.resolve([]),
    [projectPath],
  );
  const contextThreads = useMemo(
    () =>
      projects.flatMap((p) =>
        p.threads.map((t) => ({ threadId: t.id, title: t.title })),
      ),
    [projects],
  );

  async function handleAddFiles(files: File[]) {
    const added = await Promise.all(files.map(fileToImageAttachment));
    setAttachments((a) => [...a, ...added]);
  }

  function handleSubmit() {
    const trimmed = draft.trim();
    if (!trimmed && attachments.length === 0) return;
    startThread(projectId, draft, {
      model: currentModel,
      permissionMode: mode,
      thinkingLevel: thinking,
      images: attachments.length ? attachments.map((a) => a.content) : undefined,
    });
    setDraft("");
    setAttachments([]);
  }

  return (
    <Composer
      value={draft}
      onChange={setDraft}
      onSubmit={() => handleSubmit()}
      models={models}
      currentModel={currentModel}
      selecting={false}
      onSelectModel={(provider, modelId) => setModel({ provider, id: modelId })}
      mode={mode}
      onSelectMode={setMode}
      thinking={thinking}
      onSelectThinking={setThinking}
      streaming={false}
      autoFocus
      placeholder="Ask hoy, @ files, / commands..."
      widgets={[]}
      attachments={attachments}
      onAddFiles={(files) => void handleAddFiles(files)}
      onRemoveAttachment={(id) =>
        setAttachments((a) => a.filter((x) => x.id !== id))
      }
      canAttachImages={canAttachImages}
      searchPaths={searchPaths}
      threads={contextThreads}
      slashCommands={skillCommands}
      projectPath={projectPath}
    />
  );
}
