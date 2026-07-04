"use client";

// Adapted from the AI Elements `plan` component (registry.ai-sdk.dev/plan) for
// Hoy's transcript. The registry version is built on a shadcn Card primitive
// (rounded, generously padded, drop shadow) that this app deliberately does not
// use -- the transcript is dense, square-cornered and low-chrome. This keeps the
// same component API (Plan / PlanHeader / PlanTitle / PlanContent / PlanFooter /
// PlanTrigger) and the streaming-shimmer behaviour, restyled with the `agent`
// accent Hoy already uses for plan-mode surfaces. Collapsible so a long plan can
// be folded away in a busy transcript.

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { createContext, useContext } from "react";
import { Shimmer } from "./shimmer";

type PlanContextValue = { isStreaming: boolean };

const PlanContext = createContext<PlanContextValue | null>(null);

const usePlan = () => {
  const context = useContext(PlanContext);
  if (!context) {
    throw new Error("Plan components must be used within Plan");
  }
  return context;
};

export type PlanProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
};

export const Plan = ({ className, isStreaming = false, ...props }: PlanProps) => (
  <PlanContext.Provider value={{ isStreaming }}>
    <Collapsible
      className={cn(
        "group my-1 overflow-hidden rounded-lg border border-agent/40 bg-agent/5",
        className,
      )}
      {...props}
    />
  </PlanContext.Provider>
);

export type PlanHeaderProps = ComponentProps<"div">;

export const PlanHeader = ({ className, ...props }: PlanHeaderProps) => (
  <div
    className={cn(
      "flex items-center gap-2 border-b border-agent/20 px-3 py-1.5",
      className,
    )}
    {...props}
  />
);

export type PlanTitleProps = Omit<ComponentProps<"span">, "children"> & {
  children: string;
};

export const PlanTitle = ({ className, children, ...props }: PlanTitleProps) => {
  const { isStreaming } = usePlan();
  return (
    <span
      className={cn("text-xs font-medium text-agent", className)}
      {...props}
    >
      {isStreaming ? <Shimmer duration={1}>{children}</Shimmer> : children}
    </span>
  );
};

export type PlanContentProps = ComponentProps<typeof CollapsibleContent>;

export const PlanContent = ({ className, ...props }: PlanContentProps) => (
  <CollapsibleContent
    className={cn(
      "px-3 py-2 text-sm data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
);

export type PlanFooterProps = ComponentProps<"div">;

export const PlanFooter = ({ className, ...props }: PlanFooterProps) => (
  <div
    className={cn(
      "flex flex-wrap items-center justify-end gap-1.5 border-t border-agent/20 px-3 py-2",
      className,
    )}
    {...props}
  />
);

export type PlanTriggerProps = ComponentProps<typeof CollapsibleTrigger>;

// Chevron toggle. Sits in the header; rotates when open.
export const PlanTrigger = ({ className, ...props }: PlanTriggerProps) => (
  <CollapsibleTrigger
    className={cn(
      "shrink-0 text-agent/70 outline-none transition-colors hover:text-agent",
      className,
    )}
    aria-label="Toggle plan"
    {...props}
  >
    <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" />
  </CollapsibleTrigger>
);
