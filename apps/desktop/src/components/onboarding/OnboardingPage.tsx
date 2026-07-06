import { CheckCircle2, Circle, KeyRound, Palette } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ProvidersPanel } from "@/components/settings/ProvidersPanel";
import { ThemeSelector } from "@/components/settings/ThemeSelector";
import { usePrefsStore } from "@/state/prefs";
import { useSessionStore } from "@/state/store";
import { cn } from "@/lib/utils";

function StepState({
  done,
  children,
}: {
  done: boolean;
  children: ReactNode;
}) {
  const Icon = done ? CheckCircle2 : Circle;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-xs",
        done ? "text-emerald-500" : "text-muted-foreground",
      )}
    >
      <Icon className="size-3.5" />
      {children}
    </span>
  );
}

const THEME_LABELS: Record<string, string> = {
  dark: "Dark",
  light: "Light",
  system: "System",
};

export function OnboardingPage({ loading = false }: { loading?: boolean }) {
  const setPref = usePrefsStore((s) => s.setPref);
  const theme = usePrefsStore((s) => s.theme);
  const providerAuth = useSessionStore((s) => s.providerAuth);
  const providerReady = providerAuth.some((auth) => auth.configured);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-8 py-10">
        <header className="border-b border-border pb-5">
          <p className="text-sm text-muted-foreground">Welcome to Hoy</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
            Set up your workspace
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Pick an appearance and connect a model provider before starting your
            first thread.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <StepState done>Theme: {THEME_LABELS[theme] ?? "Dark"}</StepState>
            <StepState done={providerReady}>Provider connected</StepState>
          </div>
        </header>

        <section className="border border-border bg-card/40 p-5">
          <div className="mb-4 flex items-center gap-2">
            <Palette className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Appearance</h2>
          </div>
          <ThemeSelector />
        </section>

        <section className="border border-border bg-card/40 p-5">
          <div className="mb-4 flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Provider</h2>
          </div>
          {loading ? (
            <p className="text-sm text-muted-foreground">
              Checking provider status...
            </p>
          ) : (
            <ProvidersPanel />
          )}
        </section>

        <div className="sticky bottom-0 -mx-8 border-t border-border bg-background/95 px-8 py-4 backdrop-blur">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground">
              Hoy needs one configured provider before it can send prompts.
            </p>
            <Button
              disabled={!providerReady}
              onClick={() => setPref("onboardingCompleted", true)}
            >
              Continue
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
