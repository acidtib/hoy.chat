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

export async function runListSkills(
  agentDir: string,
  cwd: string,
): Promise<never> {
  const loader = new DefaultResourceLoader({ cwd, agentDir });
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
