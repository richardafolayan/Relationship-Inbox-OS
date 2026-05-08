import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "ghost" | "quiet" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: "bg-ink text-paper hover:bg-[oklch(28%_0.01_80)]",
  ghost: "text-ink-2 hover:bg-paper-2 hover:text-ink",
  quiet: "border border-hairline text-ink-2 hover:border-hairline-strong hover:bg-paper-2 hover:text-ink",
  danger: "border border-[oklch(70%_0.18_28)] text-[oklch(45%_0.18_28)] hover:bg-[oklch(94%_0.04_28)]"
};

export function Button({ className, variant = "ghost", ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill border border-transparent px-[18px] py-[11px] text-sm font-medium tracking-[-0.005em]",
        "transition-[transform,background-color,border-color,color] duration-calm ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        variantStyles[variant],
        className
      )}
      {...props}
    />
  );
}
