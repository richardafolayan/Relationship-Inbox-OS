import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "ghost" | "quiet" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: "bg-ink text-paper hover:bg-ink-2",
  ghost: "text-ink-2 hover:bg-paper-2 hover:text-ink",
  quiet: "border border-hairline text-ink-2 hover:border-hairline-strong hover:bg-paper-2 hover:text-ink",
  danger: "border border-accent-ink/50 text-accent-ink hover:bg-accent-soft"
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
