import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import type { DisplayRisk } from "@/lib/risk";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  risk: DisplayRisk;
  label?: string;
  emphasize?: boolean;
}

const dotColor: Record<DisplayRisk, string> = {
  overdue: "bg-risk-overdue",
  waiting: "bg-risk-waiting",
  fresh: "bg-risk-fresh"
};

const labelColor: Record<DisplayRisk, string> = {
  overdue: "text-risk-overdue font-medium",
  waiting: "text-ink-3",
  fresh: "text-ink-3"
};

export function Badge({ risk, label, emphasize, className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.02em]",
        emphasize ? labelColor[risk] : "text-ink-3",
        className
      )}
      {...props}
    >
      <span className={cn("h-[6px] w-[6px] rounded-full", dotColor[risk])} aria-hidden />
      <span className={emphasize && risk === "overdue" ? "text-risk-overdue font-medium" : undefined}>
        {label ?? risk}
      </span>
    </span>
  );
}
