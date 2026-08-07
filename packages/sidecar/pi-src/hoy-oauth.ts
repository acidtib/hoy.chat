// One-shot, manual-paste OAuth login. runRpcMode owns stdio and never returns,
// so OAuth (absent from Pi's RPC surface entirely) runs as its own short-lived
// invocation of the same compiled binary, selected by the HOY_OAUTH_LOGIN env
// var in hoy-sidecar.ts. It drives Pi's ModelRuntime.login, which runs the
// provider flow and persists the {type:"oauth"} entry to Hoy's auth.json
// (the same file pi_config.rs reads for status), preserving other entries.
//
// Protocol: newline-delimited JSON events on stdout. Single-line UTF-8
// responses on stdin (the raw pasted code / selected option id). Rust opens the
// auth URL, relays events to the renderer, and writes the user's paste back.
//
// Pi 0.84.0's login interaction is a unified `prompt()`/`notify()` pair (see
// AuthInteraction below), not the five separate onAuth/onDeviceCode/onPrompt/
// onSelect/onManualCodeInput callbacks pre-0.80.8 used. We restate the shape
// locally (structural typing, no deep subpath import needed) and translate it
// into the SAME wire vocabulary Rust's oauth.rs::map_event already parses
// (auth_url, device_code, progress, prompt{promptType,message,placeholder},
// select{message,options:[{id,label}]}, done, error), so Rust needs no changes.

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

// Structural mirror of pi-ai's AuthPrompt/AuthEvent/AuthInteraction (auth/types.ts).
// Restated here to avoid importing a deep subpath type.
type AuthPrompt =
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
  | { type: "manual_code"; message: string; placeholder?: string };

type AuthEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

interface AuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

// stdin line queue: buffers bytes, hands out whole lines to waiting readers.
// Rust writes exactly one line per prompt/select response.
function makeLineReader(): { next: () => Promise<string>; close: () => void } {
  const pending: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let buffer = "";

  const onData = (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      const w = waiters.shift();
      if (w) w(line);
      else pending.push(line);
    }
  };

  process.stdin.on("data", onData);
  process.stdin.resume();

  return {
    next: () =>
      new Promise<string>((resolve) => {
        const q = pending.shift();
        if (q !== undefined) resolve(q);
        else waiters.push(resolve);
      }),
    close: () => process.stdin.off("data", onData),
  };
}

export async function runOAuthLogin(
  agentDir: string,
  providerId: string,
): Promise<never> {
  const reader = makeLineReader();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json") });

  const interaction: AuthInteraction = {
    notify: (event) => {
      switch (event.type) {
        case "auth_url":
          emit({ type: "auth_url", url: event.url, instructions: event.instructions });
          break;
        case "device_code":
          emit({
            type: "device_code",
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            intervalSeconds: event.intervalSeconds,
            expiresInSeconds: event.expiresInSeconds,
          });
          break;
        case "progress":
          emit({ type: "progress", message: event.message });
          break;
        case "info":
          // Rust's progress event has no slot for links; dropping them is an
          // accepted simplification (info is otherwise just a display line).
          emit({ type: "progress", message: event.message });
          break;
      }
    },
    prompt: async (prompt) => {
      switch (prompt.type) {
        case "text":
          emit({ type: "prompt", promptType: "text", message: prompt.message, placeholder: prompt.placeholder });
          return reader.next();
        case "secret":
          // No masking on the wire yet (Rust/renderer treat any unknown
          // promptType as plain text) - functional, just not masked.
          emit({ type: "prompt", promptType: "secret", message: prompt.message, placeholder: prompt.placeholder });
          return reader.next();
        case "manual_code":
          emit({ type: "prompt", promptType: "manual_code", message: prompt.message, placeholder: prompt.placeholder });
          return reader.next();
        case "select": {
          emit({
            type: "select",
            message: prompt.message,
            options: prompt.options.map((o) => ({ id: o.id, label: o.label })),
          });
          const id = await reader.next();
          if (id === "") throw new Error("login cancelled");
          return id;
        }
      }
    },
  };

  try {
    await modelRuntime.login(providerId, "oauth", interaction);
    emit({ type: "done" });
    reader.close();
    process.exit(0);
  } catch (e) {
    emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
    reader.close();
    process.exit(1);
  }
}
