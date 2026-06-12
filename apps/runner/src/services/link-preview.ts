import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Link unfurling for URLs that appear inside message bubbles.
//
// The dashboard asks GET /data/link-preview?url=... lazily per visible URL
// and renders an iMessage-style card from the result. Everything here is
// driven by UNTRUSTED input - the URL came out of a contact's message - so
// the fetch path is locked down:
//
//   * http/https only, credentials in the URL rejected
//   * the hostname (and every redirect hop) must resolve to public unicast
//     addresses - loopback, RFC1918, link-local (cloud metadata), CGNAT,
//     ULA etc. are all refused, so a message can't probe the runner's LAN
//   * redirects are followed manually (capped) so each hop is re-checked
//   * response bodies are size-capped and time-limited
//
// DNS note: we resolve-then-fetch, so a pathological rebinding setup could
// in principle answer the check with a public address and the fetch with a
// private one. For this single-operator local app that residual risk is
// accepted; the guard's job is stopping ordinary "http://192.168.x.x/" and
// "http://localhost:4001/" probes cold.
//
// This module is framework-free (node builtins + global fetch only) so the
// test suite can import it without dragging in the runner's db/session
// wiring.

export type LinkPreviewProvider = "tiktok" | "youtube";

export type LinkPreview = {
  status: "ok" | "error";
  /** The URL that was asked about, normalized to an absolute http(s) URL. */
  url: string;
  /** Where it landed after redirects (equals url when none were followed). */
  finalUrl: string;
  /** Display host of finalUrl, "www." stripped. */
  host: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  /**
   * True when the final response's headers allow the page inside an iframe
   * (no X-Frame-Options, no restrictive CSP frame-ancestors). The in-app
   * browser only points an iframe at the page when this is true.
   */
  embeddable: boolean;
  provider: LinkPreviewProvider | null;
  /** Provider player URL that is always iframe-safe (TikTok/YouTube embed). */
  embedUrl: string | null;
};

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 8000;
const OEMBED_TIMEOUT_MS = 5000;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_OEMBED_BYTES = 256 * 1024;
const MAX_TEXT_FIELD_CHARS = 400;
const CACHE_MAX_ENTRIES = 500;
const CACHE_TTL_OK_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_ERROR_MS = 10 * 60 * 1000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// A browser-ish UA: several big sites (TikTok included) serve their Open
// Graph tags to anything that looks like a browser but bot-wall obvious
// programmatic agents.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

export type ResolveAddresses = (hostname: string) => Promise<string[]>;

const defaultResolveAddresses: ResolveAddresses = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  const c = parts[2] ?? 0;
  if (a === 0 || a === 10 || a === 127) return true; // this-net, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
  if (a === 192 && b === 168) return true; // private 192.168.0.0/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF + TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  // IPv4-mapped (::ffff:1.2.3.4) defers to the IPv4 ranges.
  const mappedV4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mappedV4) return isPrivateIPv4(mappedV4);
  const firstRaw = ip.split(":")[0] ?? "";
  const first = firstRaw === "" ? 0 : Number.parseInt(firstRaw, 16);
  if (Number.isNaN(first)) return true;
  if (first === 0) return true; // ::, ::1, v4-compatible space
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2001) {
    const secondRaw = ip.split(":")[1] ?? "";
    const second = secondRaw === "" ? 0 : Number.parseInt(secondRaw, 16);
    if (second === 0xdb8) return true; // documentation range
  }
  return false;
}

/** True when an IP literal must not be fetched (private/reserved/loopback). */
export function isPrivateAddress(address: string): boolean {
  const ip = (address.split("%")[0] ?? "").toLowerCase(); // strip zone id (fe80::1%en0)
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // not an IP literal - callers must resolve hostnames first
}

const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".home.arpa", ".lan"];

/**
 * Throws unless the URL is an http(s) target whose host resolves only to
 * public addresses. Used for the requested URL and for every redirect hop.
 */
export async function assertSafeRequestTarget(
  url: URL,
  resolveAddresses: ResolveAddresses = defaultResolveAddresses
): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("credentials in URL are not allowed");
  }
  // URL keeps IPv6 literals bracketed and lowercases/punycodes hostnames.
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!hostname) throw new Error("missing hostname");
  if (hostname === "localhost") throw new Error("blocked hostname: localhost");
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (hostname.endsWith(suffix) || hostname === suffix.slice(1)) {
      throw new Error(`blocked hostname: ${hostname}`);
    }
  }
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error(`blocked address: ${hostname}`);
    return;
  }
  let addresses: string[];
  try {
    addresses = await resolveAddresses(hostname);
  } catch {
    throw new Error(`could not resolve host: ${hostname}`);
  }
  if (!addresses.length) throw new Error(`could not resolve host: ${hostname}`);
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`host resolves to a private address: ${hostname}`);
    }
  }
}

// ---------------------------------------------------------------------------
// HTML metadata parsing
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " "
};

function safeFromCodePoint(codePoint: number): string {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function attributeValue(tag: string, names: string[]): string | null {
  for (const name of names) {
    const re = new RegExp(`(?:^|[\\s"'/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
    const match = tag.match(re);
    if (match) return match[1] ?? match[2] ?? match[3] ?? null;
  }
  return null;
}

function cleanTextField(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TEXT_FIELD_CHARS ? `${trimmed.slice(0, MAX_TEXT_FIELD_CHARS - 3)}...` : trimmed;
}

export type OpenGraphFields = {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
};

/** Best-effort Open Graph / twitter-card / title-tag extraction. */
export function parseOpenGraph(html: string, baseUrl: string): OpenGraphFields {
  // Meta tags live in <head>; capping how much we scan keeps pathological
  // pages cheap. 300k covers even tag-bloated commercial pages.
  const head = html.slice(0, 300_000);
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attributeValue(tag, ["property", "name"]) ?? "").toLowerCase();
    if (!key) continue;
    const content = attributeValue(tag, ["content"]);
    if (content == null || meta.has(key)) continue;
    meta.set(key, decodeEntities(content));
  }
  const titleTagText = head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  const title =
    meta.get("og:title") ??
    meta.get("twitter:title") ??
    (titleTagText != null ? decodeEntities(titleTagText) : null);
  const description =
    meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description") ?? null;
  const siteName = meta.get("og:site_name") ?? null;
  const rawImage =
    meta.get("og:image") ??
    meta.get("og:image:url") ??
    meta.get("og:image:secure_url") ??
    meta.get("twitter:image") ??
    meta.get("twitter:image:src") ??
    null;
  let imageUrl: string | null = null;
  if (rawImage) {
    try {
      const resolved = new URL(decodeEntities(rawImage).trim(), baseUrl);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        imageUrl = resolved.toString();
      }
    } catch {
      imageUrl = null;
    }
  }
  return {
    title: cleanTextField(title),
    description: cleanTextField(description),
    imageUrl,
    siteName: cleanTextField(siteName)
  };
}

/**
 * Whether response headers permit framing this page from another origin.
 * Any X-Frame-Options header means no; a CSP frame-ancestors directive
 * means no unless it is wildcard-open.
 */
export function detectEmbeddable(headers: Pick<Headers, "get">): boolean {
  const xfo = headers.get("x-frame-options");
  if (xfo && xfo.trim()) return false;
  const csp = headers.get("content-security-policy");
  if (csp) {
    const directive = csp
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.toLowerCase().startsWith("frame-ancestors"));
    if (directive) {
      const sources = directive.split(/\s+/).slice(1).map((source) => source.toLowerCase());
      return sources.includes("*") || sources.includes("http:") || sources.includes("https:");
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Provider detection (players that are explicitly iframe-friendly)
// ---------------------------------------------------------------------------

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

export function resolveProvider(
  finalUrl: URL
): { provider: LinkPreviewProvider; embedUrl: string | null } | null {
  const host = finalUrl.hostname.toLowerCase().replace(/^(www|m)\./, "");
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
    const idMatch = finalUrl.pathname.match(/\/(?:video|photo|v|embed\/v2)\/(\d{5,25})/);
    const isPhotoPost = /\/photo\//.test(finalUrl.pathname);
    return {
      provider: "tiktok",
      // Photo posts have no v2 player; the overlay falls back to the
      // preview panel for those.
      embedUrl: idMatch && !isPhotoPost ? `https://www.tiktok.com/embed/v2/${idMatch[1]}` : null
    };
  }
  if (host === "youtu.be") {
    const id = finalUrl.pathname.slice(1).split("/")[0] ?? "";
    return {
      provider: "youtube",
      embedUrl: YOUTUBE_ID_RE.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null
    };
  }
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    let id = finalUrl.searchParams.get("v");
    if (!id) {
      const pathMatch = finalUrl.pathname.match(/\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,20})/);
      id = pathMatch?.[1] ?? null;
    }
    return {
      provider: "youtube",
      embedUrl: id && YOUTUBE_ID_RE.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Guarded fetching
// ---------------------------------------------------------------------------

export type LinkPreviewFetchOptions = {
  fetchImpl?: typeof fetch;
  resolveAddresses?: ResolveAddresses;
  /**
   * Tests only: lets fixture servers on 127.0.0.1 through the address
   * guard. Protocol and redirect caps still apply. Never set in
   * production code paths.
   */
  allowPrivateTargets?: boolean;
  timeoutMs?: number;
};

async function guardedFetch(
  target: URL,
  accept: string,
  opts: LinkPreviewFetchOptions
): Promise<{ response: Response; finalUrl: URL }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let current = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (opts.allowPrivateTargets) {
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        throw new Error(`unsupported protocol: ${current.protocol}`);
      }
    } else {
      await assertSafeRequestTarget(current, opts.resolveAddresses);
    }
    const response = await fetchImpl(current.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS),
      headers: {
        "user-agent": BROWSER_USER_AGENT,
        accept,
        "accept-language": "en-GB,en;q=0.9"
      }
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      await discardBody(response);
      if (!location) throw new Error(`redirect without location from ${current.hostname}`);
      current = new URL(location, current);
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new Error("too many redirects");
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // best effort - an already-consumed body is fine
  }
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  let received = 0;
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // stream already done
    }
  }
  return out + decoder.decode();
}

// ---------------------------------------------------------------------------
// TikTok oEmbed (the page itself is JS-rendered + bot-walled; the official
// oEmbed endpoint reliably returns caption/author/thumbnail for video links)
// ---------------------------------------------------------------------------

type TikTokOEmbed = {
  title: string | null;
  authorName: string | null;
  thumbnailUrl: string | null;
  videoId: string | null;
};

async function fetchTikTokOEmbed(videoUrl: URL, opts: LinkPreviewFetchOptions): Promise<TikTokOEmbed | null> {
  try {
    const endpoint = new URL("https://www.tiktok.com/oembed");
    endpoint.searchParams.set("url", videoUrl.toString());
    const { response } = await guardedFetch(endpoint, "application/json", {
      ...opts,
      timeoutMs: opts.timeoutMs ?? OEMBED_TIMEOUT_MS
    });
    if (!response.ok) {
      await discardBody(response);
      return null;
    }
    const data = JSON.parse(await readBodyCapped(response, MAX_OEMBED_BYTES)) as Record<string, unknown>;
    const videoId =
      typeof data.embed_product_id === "string" && /^\d{5,25}$/.test(data.embed_product_id)
        ? data.embed_product_id
        : null;
    const thumbnailUrl =
      typeof data.thumbnail_url === "string" && /^https?:\/\//i.test(data.thumbnail_url)
        ? data.thumbnail_url
        : null;
    return {
      title: cleanTextField(typeof data.title === "string" ? data.title : null),
      authorName: cleanTextField(typeof data.author_name === "string" ? data.author_name : null),
      thumbnailUrl,
      videoId
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache + entry point
// ---------------------------------------------------------------------------

type CacheEntry = { preview: LinkPreview; expiresAt: number };
const previewCache = new Map<string, CacheEntry>();

export function clearLinkPreviewCache(): void {
  previewCache.clear();
}

function cacheGet(key: string): LinkPreview | null {
  const entry = previewCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    previewCache.delete(key);
    return null;
  }
  return entry.preview;
}

function cacheSet(key: string, preview: LinkPreview): void {
  if (previewCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = previewCache.keys().next().value;
    if (oldest !== undefined) previewCache.delete(oldest);
  }
  const ttl = preview.status === "ok" ? CACHE_TTL_OK_MS : CACHE_TTL_ERROR_MS;
  previewCache.set(key, { preview, expiresAt: Date.now() + ttl });
}

/** Parse client input into an absolute http(s) URL, or null if hopeless. */
export function normalizeRequestedUrl(raw: string): URL | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function displayHost(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

function errorPreview(rawUrl: string, target: URL | null): LinkPreview {
  return {
    status: "error",
    url: target?.toString() ?? rawUrl,
    finalUrl: target?.toString() ?? rawUrl,
    host: target ? displayHost(target) : "",
    title: null,
    description: null,
    imageUrl: null,
    siteName: null,
    embeddable: false,
    provider: null,
    embedUrl: null
  };
}

async function buildLinkPreview(target: URL, opts: LinkPreviewFetchOptions): Promise<LinkPreview> {
  const { response, finalUrl } = await guardedFetch(target, HTML_ACCEPT, opts);
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");
  let fields: OpenGraphFields = { title: null, description: null, imageUrl: null, siteName: null };
  if (response.ok && isHtml) {
    fields = parseOpenGraph(await readBodyCapped(response, MAX_HTML_BYTES), finalUrl.toString());
  } else {
    await discardBody(response);
  }

  const providerInfo = resolveProvider(finalUrl);
  let { title, description, imageUrl, siteName } = fields;
  let embedUrl = providerInfo?.embedUrl ?? null;

  if (providerInfo?.provider === "tiktok") {
    // oEmbed resolves short links itself, so when the canonical URL is
    // refused (redirect detours via an interstitial, expired chain) the
    // original message link is worth a second ask.
    const oembed =
      (await fetchTikTokOEmbed(finalUrl, opts)) ??
      (target.toString() !== finalUrl.toString() ? await fetchTikTokOEmbed(target, opts) : null);
    if (oembed) {
      title = oembed.title ?? title;
      description = description ?? oembed.authorName;
      imageUrl = oembed.thumbnailUrl ?? imageUrl;
      siteName = siteName ?? "TikTok";
      if (!embedUrl && oembed.videoId) {
        embedUrl = `https://www.tiktok.com/embed/v2/${oembed.videoId}`;
      }
    }
    // Posts TikTok won't server-render (photo posts, dead links) leak the
    // SPA shell's homepage <title>. It tells the operator nothing - drop
    // it so the card falls back to siteName + host.
    if (title === "TikTok - Make Your Day") {
      title = null;
      siteName = siteName ?? "TikTok";
    }
  }

  // A non-OK page with no salvaged metadata is an error card client-side;
  // anything with usable fields (e.g. oEmbed rescued a bot-walled TikTok
  // page) still counts as ok.
  const usable = response.ok || title !== null || imageUrl !== null;
  return {
    status: usable ? "ok" : "error",
    url: target.toString(),
    finalUrl: finalUrl.toString(),
    host: displayHost(finalUrl),
    title,
    description,
    imageUrl,
    siteName,
    embeddable: response.ok ? detectEmbeddable(response.headers) : false,
    provider: providerInfo?.provider ?? null,
    embedUrl
  };
}

/**
 * Fetch (or serve from cache) the preview for a URL found in a message.
 * Never throws: failures come back as `{ status: "error" }` so the
 * dashboard renders a plain link instead of surfacing an error.
 */
export async function getLinkPreview(rawUrl: string, opts: LinkPreviewFetchOptions = {}): Promise<LinkPreview> {
  const target = normalizeRequestedUrl(rawUrl);
  if (!target) return errorPreview(rawUrl, null);
  const cacheKey = target.toString();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  let preview: LinkPreview;
  try {
    preview = await buildLinkPreview(target, opts);
  } catch {
    preview = errorPreview(rawUrl, target);
  }
  cacheSet(cacheKey, preview);
  return preview;
}
