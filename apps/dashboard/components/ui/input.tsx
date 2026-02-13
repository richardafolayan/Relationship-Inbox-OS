import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition duration-calm placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-200",
        className
      )}
      {...props}
    />
  );
}
