import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

// forwardRef so callers (like GlobalSearch) can imperatively focus / blur.
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition duration-calm placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-200",
          className
        )}
        {...props}
      />
    );
  }
);
