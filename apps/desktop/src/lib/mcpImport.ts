// Parse a pasted MCP server config (the shape people copy from a README) into
// name → spec entries the settings form can add (HOY-273). Pure so it's testable.

export interface ParsedMcpServer {
  name: string;
  // The internal server spec: { command, args?, env? } | { url, headers? }.
  spec: Record<string, unknown>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Map one raw server object onto the internal spec. stdio (command) and http
// (url) are told apart by which field is present; args/env/headers pass through.
function toSpec(name: string, raw: unknown): Record<string, unknown> {
  if (!isObject(raw)) throw new Error(`Server "${name}" must be an object.`);
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (command) {
    const spec: Record<string, unknown> = { command };
    if (Array.isArray(raw.args)) {
      const args = raw.args.filter((a) => a != null).map(String);
      if (args.length) spec.args = args;
    }
    if (isObject(raw.env) && Object.keys(raw.env).length) spec.env = raw.env;
    return spec;
  }
  if (url) {
    const spec: Record<string, unknown> = { url };
    if (isObject(raw.headers) && Object.keys(raw.headers).length) {
      spec.headers = raw.headers;
    }
    return spec;
  }
  throw new Error(`Server "${name}" needs a "command" or "url".`);
}

// Parse a pasted config into one or more (name, spec) pairs. Accepts, in order:
//   { "mcpServers": { "<name>": { … } } }   the standard wrapper people copy
//   { "<name>": { … }, … }                   a bare name → server map
//   { "command" | "url": … }                 a single unnamed server (uses `fallbackName`)
// Throws a human-readable Error on malformed JSON or an unrecognized shape.
export function parseMcpServersJson(
  text: string,
  fallbackName?: string,
): ParsedMcpServer[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Paste an MCP server config.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObject(parsed)) throw new Error("Expected a JSON object.");

  // A single, unnamed server pasted on its own — needs a name from the form.
  if (typeof parsed.command === "string" || typeof parsed.url === "string") {
    const name = fallbackName?.trim();
    if (!name) {
      throw new Error(
        "Enter a name for this server (the JSON has no server name).",
      );
    }
    return [{ name, spec: toSpec(name, parsed) }];
  }

  const map = isObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
  const names = Object.keys(map);
  if (names.length === 0) {
    throw new Error('No servers found. Expected { "mcpServers": { "<name>": … } }.');
  }
  return names.map((name) => ({ name, spec: toSpec(name, map[name]) }));
}
