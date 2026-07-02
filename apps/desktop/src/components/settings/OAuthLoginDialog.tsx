import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Channel,
  oauthLoginCancel,
  oauthLoginStart,
  oauthLoginSubmit,
} from "@/lib/ipc";
import type { OAuthEvent, OAuthSelectOption } from "@/lib/types";
import type { SubscriptionProvider } from "./providerMeta";
import { ProviderGlyph } from "./providerIcons";

// Phases. "waiting" is the common desktop path: the login flow runs a local
// callback server, so once the user approves in the browser the redirect is
// caught automatically and "done" arrives with no paste. Manual code entry is a
// fallback (browser on another machine), kept behind a disclosure.
type Phase = "starting" | "waiting" | "select" | "input" | "done" | "error";

interface PromptInfo {
  message: string;
  placeholder?: string;
}

export function OAuthLoginDialog({
  provider,
  onOpenChange,
  onConnected,
}: {
  provider: SubscriptionProvider | null;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void | Promise<void>;
}) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  // A required text prompt (not manual_code) that we cannot skip.
  const [prompt, setPrompt] = useState<PromptInfo | null>(null);
  // The optional manual-code fallback offered while waiting on the browser.
  const [manual, setManual] = useState<PromptInfo | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [select, setSelect] = useState<{
    message: string;
    options: OAuthSelectOption[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  // Guards StrictMode's double effect; ties the flow to the open provider.
  const startedFor = useRef<string | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    if (!provider) {
      startedFor.current = null;
      return;
    }
    if (startedFor.current === provider.id) return;
    startedFor.current = provider.id;
    doneRef.current = false;

    setPhase("starting");
    setAuthUrl(null);
    setProgress(null);
    setDeviceCode(null);
    setPrompt(null);
    setManual(null);
    setShowManual(false);
    setSelect(null);
    setError(null);
    setValue("");
    setBusy(false);

    const channel = new Channel<OAuthEvent>();
    channel.onmessage = (event) => {
      switch (event.kind) {
        case "authUrl":
          setAuthUrl(event.url);
          void openUrl(event.url);
          setPhase("waiting");
          break;
        case "deviceCode":
          setAuthUrl(event.verificationUri);
          void openUrl(event.verificationUri);
          setDeviceCode(event.userCode);
          setPhase("waiting");
          break;
        case "progress":
          setProgress(event.message);
          break;
        case "prompt":
          // manual_code is the optional fallback: keep waiting on the browser
          // and expose manual entry behind a disclosure. Any other prompt is
          // required, so surface it directly.
          if (event.promptType === "manual_code") {
            setManual({ message: event.message, placeholder: event.placeholder });
          } else {
            setPrompt({ message: event.message, placeholder: event.placeholder });
            setValue("");
            setBusy(false);
            setPhase("input");
          }
          break;
        case "select":
          setSelect({ message: event.message, options: event.options });
          setPhase("select");
          break;
        case "done":
          doneRef.current = true;
          setPhase("done");
          void Promise.resolve(onConnected());
          break;
        case "error":
          setError(event.message);
          setPhase("error");
          break;
      }
    };

    oauthLoginStart(provider.id, channel).catch((e) => {
      setError(String(e));
      setPhase("error");
    });
  }, [provider, onConnected]);

  function close() {
    if (!doneRef.current) void oauthLoginCancel();
    startedFor.current = null;
    onOpenChange(false);
  }

  async function submit(text: string, keepPhase = false) {
    if (busy || !text.trim()) return;
    setBusy(true);
    if (!keepPhase) {
      setProgress(null);
      setPhase("waiting");
    }
    try {
      await oauthLoginSubmit(text.trim());
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }

  async function pickOption(id: string) {
    setBusy(true);
    setPhase("waiting");
    try {
      await oauthLoginSubmit(id);
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }

  const reopenLink = authUrl && (
    <button
      type="button"
      onClick={() => void openUrl(authUrl)}
      className="flex items-center gap-1.5 text-xs text-muted-foreground underline underline-offset-2 hover:text-brand"
    >
      <ExternalLink className="size-3" />
      Reopen the sign-in page
    </button>
  );

  return (
    <Dialog open={provider !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        {provider && (
          <DialogHeader>
            <div className="flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center border border-border bg-muted/50 text-muted-foreground">
                <ProviderGlyph slug={provider.glyph} className="size-[18px]" />
              </span>
              <div className="min-w-0">
                <DialogTitle className="text-base">
                  Sign in to {provider.label}
                </DialogTitle>
                <DialogDescription className="text-xs">
                  {provider.subtitle}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
        )}

        <div className="space-y-4 pt-1">
          {phase === "starting" && (
            <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>{progress ?? "Opening your browser..."}</span>
            </div>
          )}

          {phase === "waiting" && (
            <div className="space-y-4">
              <div className="flex items-start gap-2.5 text-sm">
                <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
                <div className="space-y-1">
                  <p className="text-foreground">
                    Waiting for you to approve access.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {progress ??
                      "Finish signing in in your browser. Hoy connects automatically, nothing to copy."}
                  </p>
                </div>
              </div>

              {deviceCode && (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">
                    Enter this code in your browser:
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="border border-border bg-muted/40 px-3 py-1.5 font-mono text-base tracking-[0.2em]">
                      {deviceCode}
                    </code>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground"
                      onClick={() =>
                        void navigator.clipboard.writeText(deviceCode)
                      }
                    >
                      Copy
                    </Button>
                  </div>
                </div>
              )}

              {reopenLink}

              {manual && !deviceCode && (
                <div className="border-t border-border/60 pt-3">
                  {showManual ? (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        {manual.message}
                      </p>
                      <div className="flex items-center gap-2">
                        <Input
                          value={value}
                          placeholder={manual.placeholder ?? "Paste code here"}
                          autoComplete="off"
                          spellCheck={false}
                          autoFocus
                          onChange={(e) => setValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void submit(value, true);
                          }}
                        />
                        <Button
                          size="sm"
                          disabled={busy || !value.trim()}
                          onClick={() => void submit(value, true)}
                        >
                          Submit
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowManual(true)}
                      className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      Browser on another device? Enter the code manually
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {phase === "input" && prompt && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{prompt.message}</p>
              {reopenLink}
              <div className="flex items-center gap-2">
                <Input
                  value={value}
                  placeholder={prompt.placeholder ?? "Enter value"}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submit(value);
                  }}
                />
                <Button
                  size="sm"
                  disabled={busy || !value.trim()}
                  onClick={() => void submit(value)}
                >
                  Submit
                </Button>
              </div>
            </div>
          )}

          {phase === "select" && select && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{select.message}</p>
              <div className="flex flex-col gap-2">
                {select.options.map((opt) => (
                  <Button
                    key={opt.id}
                    variant="outline"
                    className="justify-start"
                    disabled={busy}
                    onClick={() => void pickOption(opt.id)}
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {phase === "done" && (
            <div className="flex items-center gap-2.5 text-sm">
              <CheckCircle2 className="size-4 text-emerald-500" />
              <span>Connected. You are all set.</span>
            </div>
          )}

          {phase === "error" && (
            <p className="text-sm text-destructive">
              {error ?? "Sign-in failed."}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          {phase === "done" ? (
            <Button size="sm" onClick={close}>
              Done
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
