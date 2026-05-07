import type { TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full resize-none rounded-row border border-hairline bg-paper px-4 py-3 text-[15px] leading-[1.55] text-ink",
        "outline-none transition-[border-color] duration-calm",
        "placeholder:text-ink-4 focus:border-hairline-strong",
        className
      )}
      {...props}
    />
  );
}
