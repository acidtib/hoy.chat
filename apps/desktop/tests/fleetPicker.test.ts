import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";
import {
  BUILTIN_AGENTS,
  CORE_AGENTS,
  fleetChanges,
  matchingPreset,
} from "@/lib/fleetPresets";

const projectHasFleet = mock(async (_path: string) => false);
const setSubagentsEnabled = mock(async () => {});
const setSubagentEnabled = mock(async () => {});
const setSubagentModel = mock(async () => {});
const listSubagents = mock(async () => []);
mockIpcModule({ projectHasFleet, setSubagentsEnabled, setSubagentEnabled, setSubagentModel, listSubagents });

const { useSessionStore } = await import("@/state/store");

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("fleet presets", () => {
  test("fleetChanges states every built-in, on or off", () => {
    const changes = fleetChanges(["Coder", "Reviewer"]);
    expect(changes.map(([n]) => n)).toEqual(BUILTIN_AGENTS);
    expect(changes.filter(([, on]) => on).map(([n]) => n)).toEqual(["Coder", "Reviewer"]);
  });

  test("matchingPreset recognises a preset regardless of order, else null", () => {
    expect(matchingPreset(CORE_AGENTS)).toBe("full");
    expect(matchingPreset(["Reviewer", "Coder", "Researcher"])).toBe("lean");
    expect(matchingPreset([])).toBe("custom");
    expect(matchingPreset(["Coder", "DevOps"])).toBeNull();
  });
});

describe("the fleet picker after adding a project", () => {
  beforeEach(() => {
    useSessionStore.setState({ projects: [], panels: [], fleetPickerProjectId: null });
    projectHasFleet.mockClear();
    setSubagentsEnabled.mockClear();
  });

  test("opens for a project with no saved fleet", async () => {
    projectHasFleet.mockImplementationOnce(async () => false);
    useSessionStore.getState().addProject("/tmp/fleet-new");
    await flush();
    const id = useSessionStore.getState().projects[0].id;
    expect(projectHasFleet).toHaveBeenCalledWith("/tmp/fleet-new");
    expect(useSessionStore.getState().fleetPickerProjectId).toBe(id);
  });

  test("stays closed when the repo already carries a fleet", async () => {
    projectHasFleet.mockImplementationOnce(async () => true);
    useSessionStore.getState().addProject("/tmp/fleet-shared");
    await flush();
    expect(useSessionStore.getState().fleetPickerProjectId).toBeNull();
  });

  test("does not ask again when an open project is added again", async () => {
    useSessionStore.getState().addProject("/tmp/fleet-dup");
    await flush();
    projectHasFleet.mockClear();
    useSessionStore.getState().addProject("/tmp/fleet-dup");
    await flush();
    expect(projectHasFleet).not.toHaveBeenCalled();
  });

  test("saveFleet writes the whole fleet to the project and closes the picker", async () => {
    useSessionStore.getState().addProject("/tmp/fleet-save");
    await flush();
    const id = useSessionStore.getState().projects[0].id;
    await useSessionStore.getState().saveFleet(id, ["Coder"]);
    expect(setSubagentsEnabled).toHaveBeenCalledWith("project", fleetChanges(["Coder"]), "/tmp/fleet-save");
    expect(useSessionStore.getState().fleetPickerProjectId).toBeNull();
  });
});

describe("a project's Agents tab", () => {
  beforeEach(() => {
    useSessionStore.setState({
      projects: [{ id: "p1", name: "proj", path: "/tmp/proj", threads: [] }],
      fleetPickerProjectId: null,
      fleetPickerInitial: null,
    });
    setSubagentEnabled.mockClear();
    setSubagentModel.mockClear();
    listSubagents.mockClear();
  });

  test("switching an agent writes the project scope and reloads that project's agents", async () => {
    await useSessionStore.getState().setProjectAgentEnabled("p1", "Tester", false);
    expect(setSubagentEnabled).toHaveBeenCalledWith("project", "Tester", false, "/tmp/proj");
    expect(listSubagents).toHaveBeenCalledWith("/tmp/proj");
  });

  test("picking a model writes the project scope; null clears it", async () => {
    await useSessionStore.getState().setProjectAgentModel("p1", "Researcher", "anthropic/haiku");
    await useSessionStore.getState().setProjectAgentModel("p1", "Researcher", null);
    expect(setSubagentModel.mock.calls).toEqual([
      ["project", "Researcher", "anthropic/haiku", "/tmp/proj"],
      ["project", "Researcher", null, "/tmp/proj"],
    ]);
  });

  test("an unknown project writes nothing", async () => {
    await useSessionStore.getState().setProjectAgentEnabled("nope", "Coder", false);
    expect(setSubagentEnabled).not.toHaveBeenCalled();
  });

  test("reopening the picker starts from the project's current fleet", () => {
    useSessionStore.getState().setFleetPicker("p1", ["Coder"]);
    expect(useSessionStore.getState().fleetPickerInitial).toEqual(["Coder"]);
    useSessionStore.getState().setFleetPicker(null);
    expect(useSessionStore.getState().fleetPickerInitial).toBeNull();
  });
});
