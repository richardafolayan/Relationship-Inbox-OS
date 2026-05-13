"use client";

import { Fragment, type ReactNode } from "react";
import { parseWhatsAppFormat, type FormatSpan } from "@/lib/whatsapp-format";

interface WhatsAppTextProps {
  text: string;
}

/**
 * Render a WhatsApp message body with the platform's lightweight
 * markdown rendering (*bold*, _italic_, ~strike~, ```mono```). Falls
 * through to plain text when there are no markers — so iMessage /
 * LinkedIn bubbles that happen to share this component would just
 * render the body unchanged (we do gate the call site on
 * `thread.platform === "WHATSAPP"` though, so this is belt-and-braces).
 *
 * URLs in the body are wrapped in <a target="_blank"> so the operator
 * can click through to the link target without leaving the dashboard.
 */
export function WhatsAppText({ text }: WhatsAppTextProps) {
  if (!text || text.length === 0) return null;
  const spans = parseWhatsAppFormat(text);
  return <>{spans.map((s, i) => renderSpan(s, i))}</>;
}

function renderSpan(span: FormatSpan, key: number): ReactNode {
  switch (span.kind) {
    case "text":
      return <Fragment key={key}>{span.text}</Fragment>;
    case "bold":
      return (
        <strong key={key} className="font-semibold">
          {span.children.map((c, i) => renderSpan(c, i))}
        </strong>
      );
    case "italic":
      return (
        <em key={key} className="italic">
          {span.children.map((c, i) => renderSpan(c, i))}
        </em>
      );
    case "strike":
      return (
        <s key={key} className="line-through opacity-80">
          {span.children.map((c, i) => renderSpan(c, i))}
        </s>
      );
    case "code":
      return (
        <code
          key={key}
          className="rounded bg-paper-2/60 px-[4px] py-[1px] font-mono text-[13px] text-ink"
        >
          {span.text}
        </code>
      );
    case "link":
      return (
        <a
          key={key}
          href={span.href}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-ink-3 underline-offset-2 hover:text-ink"
        >
          {span.text}
        </a>
      );
  }
}
