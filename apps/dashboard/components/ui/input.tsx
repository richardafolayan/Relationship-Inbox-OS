import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

// forwardRef so callers (like the palette) can imperatively focus / blur.
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "h-10 w-full rounded-pill border border-hairline bg-paper px-4 text-sm text-ink",
          "outline-none transition-[border-color] duration-calm",
          "placeholder:text-ink-4 focus:border-hairline-strong",
          className
        )}
        {...props}
      />
    );
  }
);
