// One-shot, manual-paste OAuth login. runRpcMode owns stdio and never returns,
// so OAuth (absent from Pi's RPC surface entirely) runs as its own short-lived
// invocation of the same compiled binary, selected by the HOY_OAUTH_LOGIN env
// var in hoy-sidecar.ts. It drives Pi's AuthStorage.login, which runs the
// provider flow and persists the {type:"oauth"} entry to the branded auth.json
// (the same file pi_config.rs reads for status), preserving other entries.
//
// Protocol: newline-delimited JSON events on stdout; single-line UTF-8
// responses on stdin (the raw pasted code / selected option id). Rust opens the
// auth URL, relays events to the renderer, and writes the user's paste back.

import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

// Callback shape Pi hands provider.login. Mirrors pi-ai OAuthLoginCallbacks; we
// only depend on the fields we drive, so it is restated here to avoid importing
// a deep subpath type.
interface OAuthLoginCallbacks {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onDeviceCode: (info: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }) => void;
  onPrompt: (prompt: {
    message: string;
    placeholder?: string;
    allowEmpty?: boolean;
  }) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  onSelect: (prompt: {
    message: string;
    options: { id: string; label: string }[];
  }) => Promise<string | undefined>;
  signal?: AbortSignal;
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
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));

  const callbacks: OAuthLoginCallbacks = {
    onAuth: (info) =>
      emit({ type: "auth_url", url: info.url, instructions: info.instructions }),
    onDeviceCode: (info) =>
      emit({
        type: "device_code",
        userCode: info.userCode,
        verificationUri: info.verificationUri,
        intervalSeconds: info.intervalSeconds,
        expiresInSeconds: info.expiresInSeconds,
      }),
    onProgress: (message) => emit({ type: "progress", message }),
    onPrompt: (prompt) => {
      emit({
        type: "prompt",
        promptType: "text",
        message: prompt.message,
        placeholder: prompt.placeholder,
      });
      return reader.next();
    },
    onManualCodeInput: () => {
      emit({
        type: "prompt",
        promptType: "manual_code",
        message: "Paste the authorization code or full redirect URL",
      });
      return reader.next();
    },
    onSelect: async (prompt) => {
      emit({ type: "select", message: prompt.message, options: prompt.options });
      const id = await reader.next();
      return id === "" ? undefined : id;
    },
  };

  try {
    await authStorage.login(providerId, callbacks);
    emit({ type: "done" });
    reader.close();
    process.exit(0);
  } catch (e) {
    emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
    reader.close();
    process.exit(1);
  }
}
