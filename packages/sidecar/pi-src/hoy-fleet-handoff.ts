// HOY-379: a Fleet run that was handed the wrong kind of task passes it on.
// The renderer reads the call from the transcript when the run ends; nothing
// round-trips, so the tool only validates and tells the agent to stop.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const FLEET_HANDOFF_TOOL = "fleet_handoff";

export function createHoyFleetHandoff(self: string, agents: string[]) {
  const others = agents.filter((a) => a !== self);
  return function hoyFleetHandoff(pi: ExtensionAPI) {
    pi.registerTool({
      name: FLEET_HANDOFF_TOOL,
      label: "Hand Off",
      description: `Pass this issue to another agent because it is not ${self} work. Call it before doing the work, then stop. Agents: ${others.join(", ") || "(none)"}. Omit agent to let the Dispatcher choose.`,
      promptSnippet: "fleet_handoff (pass an issue that is not your kind of work to another agent)",
      promptGuidelines: [
        `If the issue you were handed is clearly not ${self} work (for example it only asks a question, or asks for a plan when you implement), call fleet_handoff with the agent that should take it and why, instead of doing it. Do not use it to skip hard work or to ask for review; finishing the issue already routes it onward.`,
      ],
      parameters: Type.Object({
        agent: Type.Optional(Type.String({ description: `One of: ${others.join(", ")}.` })),
        reason: Type.String({ description: "One sentence on why this agent is the wrong one, shown to the user." }),
      }),
      execute: async (_id, params) => {
        const named = params.agent?.trim();
        const agent = named ? (others.find((a) => a.toLowerCase() === named.toLowerCase()) ?? null) : null;
        if (named && !agent) throw new Error(`Unknown agent "${named}". Pick one of: ${others.join(", ")}.`);
        const handoff = { agent, reason: params.reason.trim() };
        return {
          content: [
            {
              type: "text" as const,
              text: `${JSON.stringify({ handoff })}\nHanded off. Do not work on the issue; end your turn with one line saying who takes it and why.`,
            },
          ],
          details: { handoff },
        };
      },
    });
  };
}
