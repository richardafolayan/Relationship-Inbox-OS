// Flattening a whatsapp-web.js Message into the single text string we persist
// on Message.text (and mirror into Thread.lastMessagePreview). Pure — no
// whatsapp-web.js or Prisma imports — so both the adapter's per-message
// normalisation and groupResolver's preview go through the same renderer and
// can't diverge.
//
// The load-bearing rule: never dump a raw base64 media payload into the
// timeline or the inbox preview. Some WhatsApp message shapes (status
// broadcasts, stickers, and certain media-without-caption messages) carry the
// encoded image bytes in `.body`. Rendering those verbatim shows the operator
// a multi-kilobyte "/9j/4AAQSkZJRg…" string instead of readable text. We
// detect that case and substitute a "[image]"/"[media]"-style placeholder.

/**
 * Subset of the wweb.js Message shape we read for text rendering.
 * Defined narrowly so the helper is unit-testable without dragging in
 * the full Message class (which carries the Puppeteer client reference).
 */
export interface WaTextMessageLike {
  body?: string;
  hasMedia?: boolean;
  type?: string;
  pollName?: string;
  pollOptions?: ReadonlyArray<{ name?: string }>;
  allowMultipleAnswers?: boolean;
}

/**
 * True when `body` looks like a raw base64-encoded media payload rather than
 * human-readable text. WhatsApp occasionally puts the encoded bytes of an
 * image / sticker directly in Message.body (observed on status@broadcast and
 * some media messages), and we must never surface that to the operator.
 *
 * Heuristic — all must hold:
 *   - a `data:...;base64,` URI (explicit), OR
 *   - long (real captions/prose are shorter or contain spaces),
 *   - no whitespace (base64 payloads are one unbroken run),
 *   - strict base64 alphabet only, and
 *   - a mix of upper/lower/digit characters — genuine base64 of binary data
 *     always mixes classes, which rules out long homogeneous strings like
 *     "xxxx…" that happen to satisfy the alphabet.
 */
export function looksLikeBase64Media(body: string | null | undefined): boolean {
  if (!body) return false;
  const s = body.trim();
  if (s.length === 0) return false;
  if (/^data:[^;,]*;base64,/i.test(s)) return true;
  if (s.length < 256) return false;
  if (/\s/.test(s)) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  return /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);
}

/**
 * Readable placeholder for a media message keyed on the wweb.js message type.
 * Falls back to the generic "[media]" for unknown / unspecified types.
 */
export function mediaPlaceholderForType(type?: string): string {
  switch (type) {
    case "image":
      return "[image]";
    case "sticker":
      return "[sticker]";
    case "video":
      return "[video]";
    case "gif":
      return "[gif]";
    case "audio":
    case "ptt":
      return "[voice message]";
    case "document":
      return "[document]";
    case "location":
    case "live_location":
      return "[location]";
    case "vcard":
    case "multi_vcard":
      return "[contact card]";
    default:
      return "[media]";
  }
}

/**
 * Flatten any wweb.js Message into the single text string we persist on
 * Message.text. Polls become a readable question + bullet list so the
 * thread timeline shows what was asked rather than an empty bubble; media
 * messages (and any body that is actually a base64 payload) become a
 * "[image]"/"[media]" placeholder. Plain text passes through unchanged.
 */
export function renderMessageText(msg: WaTextMessageLike): string {
  if (msg.type === "poll_creation") {
    const question = (msg.pollName ?? "").trim();
    const options = (msg.pollOptions ?? [])
      .map((o) => (o?.name ?? "").trim())
      .filter((name) => name.length > 0)
      .map((name) => `• ${name}`)
      .join("\n");
    const header = msg.allowMultipleAnswers ? "📊 Poll (multi-select)" : "📊 Poll";
    const body = question.length > 0 ? `${header}: ${question}` : header;
    return options.length > 0 ? `${body}\n${options}` : body;
  }
  // Real text passes through, but a body that is actually a base64 media
  // payload must not: fall through to the media placeholder instead.
  if (msg.body && msg.body.length > 0 && !looksLikeBase64Media(msg.body)) {
    return msg.body;
  }
  if (msg.hasMedia || looksLikeBase64Media(msg.body)) {
    return mediaPlaceholderForType(msg.type);
  }
  return "";
}
