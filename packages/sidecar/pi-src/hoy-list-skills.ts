// One-shot skill-registry dump for the settings UI (HOY-323). Rust spawns the
// sidecar binary with HOY_LIST_SKILLS=1, captures stdout, and exits us. It builds
// the same DefaultResourceLoader the runtime uses (cwd + agentDir), so the UI
// never drifts from what actually loads, then prints the discovered skills plus
// any validation diagnostics (invalid name/description, collisions) as JSON.
//
// getSkills() carries more than get_commands exposes over RPC: the file path,
// the source scope, disableModelInvocation, and the diagnostics: the metadata
// the management panel needs, and the reason this is a dump rather than a reuse
// of get_commands.

import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { ensureBuiltinSkills, isBuiltinSkillPath } from "./hoy-skills";

export async function runListSkills(
  agentDir: string,
  cwd: string,
): Promise<never> {
  // Same staging as the runtime factory (hoy-skills.ts), appended last so the
  // dump resolves precedence exactly like a live session: disk skills win.
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalSkillPaths: ensureBuiltinSkills(agentDir),
  });
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  const payload = {
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      filePath: s.filePath,
      // "user" (global ~/.hoy/skills) | "project" (.hoy/skills) | "temporary".
      scope: s.sourceInfo.scope,
      disableModelInvocation: s.disableModelInvocation,
      // Compiled into the sidecar (hoy-skills.ts), read-only in the panel.
      builtin: isBuiltinSkillPath(s.filePath, agentDir),
    })),
    diagnostics: diagnostics.map((d) => ({
      type: d.type,
      message: d.message,
      path: d.path ?? null,
    })),
  };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}
