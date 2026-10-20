import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LinearIcon } from "@/components/icons/LinearIcon";
import { GitHubIcon, JiraIcon } from "@/components/icons/SourceIcons";
import { linearTeams } from "@/lib/ipc";
import type { LinearTeam, Project } from "@/lib/types";
import { useLinearStore } from "@/state/linear";
import { useSessionStore } from "@/state/store";

const CONNECT = "__connect__";

// HOY-374: link a project to its task source: source, workspace, team. Linear
// is live; GitHub and Jira are listed as coming soon. `onLinked` runs after a
// team is linked.
export function SourceForm({ project, onLinked }: { project: Project; onLinked?: () => void }) {
  const status = useLinearStore((s) => s.status);
  const connectOAuth = useLinearStore((s) => s.connectOAuth);
  const cancelOAuth = useLinearStore((s) => s.cancelOAuth);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const setProjectLinear = useSessionStore((s) => s.setProjectLinear);
  const workspaces = useMemo(() => status?.workspaces ?? [], [status]);
  const workspaceKey = workspaces.map((w) => w.id).join(",");
  const [teams, setTeams] = useState<LinearTeam[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reload whenever a workspace is connected or removed.
  useEffect(() => {
    if (workspaces.length === 0) return;
    let cancelled = false;
    setError(null);
    linearTeams().then(
      (t) => !cancelled && setTeams(t),
      (e) => !cancelled && setError(String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceKey, workspaces.length]);

  const activeWorkspace = workspaceId && workspaces.some((w) => w.id === workspaceId)
    ? workspaceId
    : (workspaces[0]?.id ?? null);
  const workspaceTeams = (teams ?? []).filter((t) => (t.workspaceId ?? "") === (activeWorkspace ?? ""));
  const team =
    workspaceTeams.find((t) => t.id === teamId) ??
    (workspaceTeams.length === 1 ? workspaceTeams[0] : undefined);

  const signIn = async () => {
    if (!status?.oauthAvailable) {
      setSettingsOpen(true, "integrations");
      return;
    }
    setSigningIn(true);
    setError(null);
    try {
      await connectOAuth();
    } catch (e) {
      if (!String(e).includes("cancelled")) setError(String(e));
    } finally {
      setSigningIn(false);
    }
  };

  const link = () => {
    if (!team) return;
    setProjectLinear(project.id, {
      teamId: team.id,
      teamKey: team.key,
      teamName: team.name,
      workspaceId: team.workspaceId ?? null,
      workspaceName: team.workspaceName ?? null,
    });
    onLinked?.();
  };

  return (
    <div className="space-y-3">
      <Field label="Source">
        <Select value="linear">
          <SelectTrigger className="w-full cursor-pointer">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="linear">
              <LinearIcon className="size-3.5" />
              Linear
            </SelectItem>
            <SelectItem value="github" disabled>
              <GitHubIcon className="size-3.5" />
              GitHub Issues (coming soon)
            </SelectItem>
            <SelectItem value="jira" disabled>
              <JiraIcon className="size-3.5" />
              Jira (coming soon)
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>

      {!status ? (
        <p className="text-xs text-muted-foreground">Checking Linear...</p>
      ) : workspaces.length === 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Sign in to Linear to pick a team.</p>
          <SignInButton signingIn={signingIn} onSignIn={() => void signIn()} onCancel={() => void cancelOAuth()} />
        </div>
      ) : (
        <>
          <Field label="Workspace">
            <Select
              value={activeWorkspace ?? undefined}
              disabled={signingIn}
              onValueChange={(v) => {
                if (v === CONNECT) void signIn();
                else {
                  setWorkspaceId(v);
                  setTeamId(null);
                }
              }}
            >
              <SelectTrigger className="w-full cursor-pointer">
                <SelectValue placeholder="Choose a workspace" />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((w) => (
                  <SelectItem key={w.id || "legacy"} value={w.id}>
                    {w.name || "Linear workspace"}
                  </SelectItem>
                ))}
                <SelectSeparator />
                <SelectItem value={CONNECT}>Connect another workspace...</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {signingIn && (
            <SignInButton signingIn onSignIn={() => {}} onCancel={() => void cancelOAuth()} />
          )}
          <Field label="Team">
            <Select
              value={team?.id}
              disabled={!teams || workspaceTeams.length === 0}
              onValueChange={setTeamId}
            >
              <SelectTrigger className="w-full cursor-pointer">
                <SelectValue
                  placeholder={!teams ? "Loading teams..." : workspaceTeams.length === 0 ? "No teams" : "Choose a team"}
                />
              </SelectTrigger>
              <SelectContent>
                {workspaceTeams.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    <span className="font-mono text-xs text-muted-foreground">{t.key}</span>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button className="w-full cursor-pointer" disabled={!team} onClick={link}>
            Link team
          </Button>
        </>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function SignInButton({
  signingIn,
  onSignIn,
  onCancel,
}: {
  signingIn: boolean;
  onSignIn: () => void;
  onCancel: () => void;
}) {
  if (signingIn) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        Waiting for Linear in your browser...
        <Button variant="ghost" size="sm" className="ml-auto cursor-pointer" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <Button className="w-full cursor-pointer" onClick={onSignIn}>
      Sign in with Linear
    </Button>
  );
}
