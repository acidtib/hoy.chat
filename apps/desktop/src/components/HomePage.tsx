import { Sparkle } from "lucide-react";

export function HomePage() {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-background">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-10">
        <div className="flex items-center gap-2 pt-10">
          <Sparkle className="size-5 text-brand" />
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            What&rsquo;s up next?
          </h1>
        </div>
      </div>
    </div>
  );
}
