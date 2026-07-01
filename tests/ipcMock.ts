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
    createSession: mock(),
    deleteSessionFile: mock(),
    enqueuePrompt: mock(),
    getMessages: mock(),
    getSessionStats: mock(),
    getState: mock(),
    listModels: mock(),
    loadWorkspace: mock(),
    pickDirectory: mock(),
    providerStatuses: mock(),
    removeProviderKey: mock(),
    respondPermission: mock(),
    saveProviderKey: mock(),
    saveWorkspace: mock(),
    sendPrompt: mock(),
    setModel: mock(),
    setPermissionMode: mock(),
    setThinkingLevel: mock(),
    supportedProviders: mock(),
    ...overrides,
  }));
}
