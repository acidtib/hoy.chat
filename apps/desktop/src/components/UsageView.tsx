import { UsageDashboard } from "@/components/home/UsageDashboard";

// Full-screen Usage view (HOY-264), rendered by App as the "usage" bodyView.
// Gives the dashboard the whole canvas; width-constrained for readability.
export function UsageView() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-6xl px-8 py-8">
        <UsageDashboard />
      </div>
    </div>
  );
}
