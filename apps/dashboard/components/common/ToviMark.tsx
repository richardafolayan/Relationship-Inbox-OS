import { cn } from "@/lib/utils";

// The Tovi brand mark: the app-icon artwork (speech bubble + amber dot on a
// cream tile), kept byte-identical to apps/desktop/assets/icon.svg geometry.
export function ToviMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      role="img"
      aria-label="Tovi"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("h-8 w-8", className)}
    >
      <rect x="36" y="36" width="440" height="440" rx="96.8" fill="#F7F2E8" />
      <path
        d="M 146 374 C 106 352 80 313 75 266 C 69 212 90 160 132 124 C 171 91 220 76 271 81 C 334 87 387 117 418 162 C 447 204 450 260 426 310 C 399 365 346 394 282 394 H 224 C 207 394 191 399 177 408 L 126 440"
        fill="none"
        stroke="#202A35"
        strokeWidth="26"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="translate(71.200 71.200) scale(0.721875)"
      />
      <circle cx="254.556" cy="253.113" r="21.656" fill="#D9902F" />
    </svg>
  );
}
