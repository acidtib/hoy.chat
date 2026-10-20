// HOY-368: the fleet a project starts with. Mirrors the built-in roster in
// hoy-agents-registry.ts (core on by default, the optional catalog off).

export const CORE_AGENTS = [
  "Researcher",
  "Architect",
  "Coder",
  "Tester",
  "Reviewer",
  "Writer",
  "Project Manager",
];
export const OPTIONAL_AGENTS = ["Security Reviewer", "DevOps", "Frontend"];
export const BUILTIN_AGENTS = [...CORE_AGENTS, ...OPTIONAL_AGENTS];

export type FleetPresetId = "full" | "lean" | "solo" | "custom";

export interface FleetPreset {
  id: FleetPresetId;
  label: string;
  description: string;
  agents: string[];
}

export const FLEET_PRESETS: FleetPreset[] = [
  {
    id: "full",
    label: "Full fleet",
    description: "All seven core agents",
    agents: CORE_AGENTS,
  },
  {
    id: "lean",
    label: "Lean",
    description: "Research, code, review",
    agents: ["Researcher", "Coder", "Reviewer"],
  },
  { id: "solo", label: "Solo", description: "Just a coder", agents: ["Coder"] },
  {
    id: "custom",
    label: "Custom only",
    description: "Only agents you define",
    agents: [],
  },
];

// Every built-in, on or off, so the project file states the whole fleet.
export function fleetChanges(selected: Iterable<string>): Array<[string, boolean]> {
  const on = new Set(selected);
  return BUILTIN_AGENTS.map((name) => [name, on.has(name)]);
}

// The preset a selection matches exactly, if any.
export function matchingPreset(selected: Iterable<string>): FleetPresetId | null {
  const on = [...new Set(selected)].filter((n) => BUILTIN_AGENTS.includes(n)).sort();
  for (const p of FLEET_PRESETS) {
    const want = [...p.agents].sort();
    if (want.length === on.length && want.every((n, i) => n === on[i])) return p.id;
  }
  return null;
}
