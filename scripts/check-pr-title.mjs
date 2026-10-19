// Validates a PR title (the squash commit Release Please reads) as a
// Conventional Commit. Used by .github/workflows/pr-title.yml and locally:
//   bun run check:pr-title 'fix(sidecar): keep mcp servers per session'
// Types come from release-please-config.json so the check and the changelog agree.

import { readFileSync } from "node:fs";

// Keep in sync with "Commits and pull requests" in AGENTS.md.
const SCOPES = ["ui", "core", "sidecar", "site", "pi", "mcp", "auth", "config"];

const config = JSON.parse(readFileSync(new URL("../release-please-config.json", import.meta.url), "utf8"));
const TYPES = config["changelog-sections"].map((s) => s.type);

const HEADER = /^(?<type>[a-z]+)(?:\((?<scopes>[^()]+)\))?(?<bang>!)?: (?<description>.+)$/;

function checkTitle(title) {
  const match = HEADER.exec(title);
  if (!match?.groups) return [`"${title}" is not "<type>(<scope>): <description>"`];
  const errors = [];
  const { type, scopes, description } = match.groups;
  if (!TYPES.includes(type)) errors.push(`unknown type "${type}" (one of: ${TYPES.join(", ")})`);
  if (scopes !== undefined) {
    for (const scope of scopes.split(",").map((s) => s.trim())) {
      if (!SCOPES.includes(scope)) errors.push(`unknown scope "${scope}" (one of: ${SCOPES.join(", ")})`);
    }
  }
  if (!/^[a-z0-9]/.test(description)) errors.push("description must start lowercase");
  if (/[.\s]$/.test(description)) errors.push("description must not end with a period or space");
  if (description.includes("—")) errors.push("no em dashes; use a hyphen");
  return errors;
}

const title = process.argv[2] ?? "";
const errors = checkTitle(title);
if (errors.length > 0) {
  console.error(`PR title rejected: ${title}`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`PR title ok: ${title}`);
