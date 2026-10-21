import { expect, test } from "bun:test";
import { createHoyFleetHandoff, FLEET_HANDOFF_TOOL } from "./hoy-fleet-handoff";

function mount() {
  const tools: Record<string, any> = {};
  createHoyFleetHandoff("Coder", ["Coder", "Researcher", "Reviewer"])({
    registerTool: (t: any) => (tools[t.name] = t),
  } as any);
  return tools[FLEET_HANDOFF_TOOL];
}

test("records the handoff on the first output line, matching the agent's case", async () => {
  const out = await mount().execute("1", { agent: "researcher", reason: "Only asks a question." });
  const first = out.content[0].text.split("\n")[0];
  expect(JSON.parse(first)).toEqual({ handoff: { agent: "Researcher", reason: "Only asks a question." } });
});

test("no agent leaves the choice to the Dispatcher", async () => {
  const out = await mount().execute("1", { reason: "Not code work." });
  expect(out.details).toEqual({ handoff: { agent: null, reason: "Not code work." } });
});

test("rejects itself and unknown agents", async () => {
  await expect(mount().execute("1", { agent: "Coder", reason: "x" })).rejects.toThrow("Unknown agent");
  await expect(mount().execute("1", { agent: "Wizard", reason: "x" })).rejects.toThrow("Unknown agent");
  expect(mount().description).toContain("Researcher, Reviewer");
});
