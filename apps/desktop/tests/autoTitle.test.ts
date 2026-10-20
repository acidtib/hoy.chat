import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Thread } from "@/lib/types";
import { mockIpcModule } from "./ipcMock";

const generateTitle = mock(async (_text: string, _model: unknown) => "Postgres API connection" as string | null);
const createSession = mock(async () => "sess_title");
const getState = mock(async () => ({ model: { provider: "p", id: "m" }, thinkingLevel: "off" }));
const sendPrompt = mock(async () => {});
mockIpcModule({ generateTitle, createSession, getState, sendPrompt });

const { useSessionStore } = await import("@/state/store");
// The live mock: bun shares module mocks across files, so another file's
// registration may be the one the store is bound to.
const ipc = (await import("@/lib/ipc")) as unknown as { generateTitle: typeof generateTitle };
const titleMock = () => ipc.generateTitle;
const { usePrefsStore } = await import("@/state/prefs");

const flush = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean) {
  for (let i = 0; i < 50 && !cond(); i++) await flush();
}
let sessionN = 0;

function seed(thread: Partial<Thread>) {
  createSession.mockImplementation(async () => `sess_title_${++sessionN}`);
  useSessionStore.setState({
    projects: [
      { id: "p1", name: "proj", path: "/tmp/proj", threads: [{ id: "t1", title: "New thread", updatedAt: 0, sessionId: null, ...thread }] },
    ],
    panels: [],
    turns: {},
    streaming: {},
    stats: {},
    threadErrors: {},
  });
}
const title = () => useSessionStore.getState().projects[0].threads[0].title;

describe("automatic thread titles", () => {
  beforeEach(() => {
    titleMock().mockClear();
    titleMock().mockImplementation(async () => "Postgres API connection");
    usePrefsStore.setState({ autoTitles: true });
  });

  test("the first message names a user thread, after showing its first line", async () => {
    seed({});
    let resolve!: (t: string) => void;
    titleMock().mockImplementationOnce(() => new Promise<string | null>((r) => (resolve = r)));
    const sent = useSessionStore.getState().submitPrompt("t1", "how do I connect postgres to my API");
    await until(() => titleMock().mock.calls.length > 0);
    expect(title()).toBe("how do I connect postgres to my API");
    resolve("Postgres API connection");
    await sent;
    await flush();
    expect(titleMock()).toHaveBeenCalledTimes(1);
    expect(title()).toBe("Postgres API connection");
  });

  test("a rename before the title lands wins", async () => {
    seed({});
    let resolve!: (t: string) => void;
    titleMock().mockImplementationOnce(() => new Promise<string | null>((r) => (resolve = r)));
    const sent = useSessionStore.getState().submitPrompt("t1", "fix the login bug");
    await until(() => titleMock().mock.calls.length > 0);
    useSessionStore.getState().renameThread("t1", "My name");
    resolve("Login bug fix");
    await sent;
    await flush();
    expect(title()).toBe("My name");
  });

  test("agent threads and the off setting skip the helper", async () => {
    seed({ agent: "Coder" });
    await useSessionStore.getState().submitPrompt("t1", "do the thing");
    usePrefsStore.setState({ autoTitles: false });
    seed({});
    await useSessionStore.getState().submitPrompt("t1", "do another thing");
    await flush();
    expect(titleMock()).not.toHaveBeenCalled();
  });
});
