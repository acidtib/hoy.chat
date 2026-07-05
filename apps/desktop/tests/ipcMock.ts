import { mock } from "bun:test";

// Register the @/lib/ipc module mock with every export the store needs at
// import time. Call BEFORE `await import("@/state/store")`. Pass overrides to
// capture named mocks a test asserts against.
export function mockIpcModule(overrides: Record<string, unknown> = {}): void {
  mock.module("@/lib/ipc", () => ({
    Channel: class {},
    abort: mock(),
    activeSessionId: mock(),
    closeSession: mock(),
    compact: mock(),
    setAutoCompaction: mock(),
    createSession: mock(),
    deleteSessionFile: mock(),
    enqueuePrompt: mock(),
    evaluateGoal: mock(),
    getCommands: mock(),
    getMessages: mock(),
    getSessionStats: mock(),
    getState: mock(),
    getUsageStats: mock(),
    listModels: mock(),
    listProjectPaths: mock(),
    listSubagents: mock(),
    loadWorkspace: mock(),
    readContextFile: mock(),
    readSessionTranscript: mock(),
    pickDirectory: mock(),
    providerStatuses: mock(),
    removeMcpServer: mock(),
    removeProviderKey: mock(),
    respondPermission: mock(),
    saveMcpServer: mock(),
    saveProviderKey: mock(),
    saveWorkspace: mock(),
    sendPrompt: mock(),
    setKeepAwake: mock(),
    setModel: mock(),
    setPermissionMode: mock(),
    setSubagentEnabled: mock(),
    setThinkingLevel: mock(),
    supportedProviders: mock(),
    ...overrides,
  }));
}
