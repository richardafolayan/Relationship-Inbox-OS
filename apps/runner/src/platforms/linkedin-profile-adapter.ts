import type { Page } from "playwright";
import { cleanText, humanDelay, safeTruncate } from "./utils";

/**
 * Structured projection of a LinkedIn profile. Every list field defaults
 * to `[]` so the orchestration layer can persist a partial result when
 * some sections are missing — only the whole-page failure modes (private
 * profile, timeout, auth wall) bail out with `{ failed: true }`.
 */
export interface ExtractedProfile {
  failed?: false;
  headline: string | null;
  about: string | null;
  location: string | null;
  currentCompany: string | null;
  currentRole: string | null;
  mutualCount: number | null;
  followersCount: number | null;
  experience: Array<{
    title: string | null;
    company: string | null;
    dates: string | null;
    description: string | null;
  }>;
  education: Array<{
    institution: string | null;
    degree: string | null;
    field: string | null;
    dates: string | null;
  }>;
  skills: string[];
  services: string[];
  licenses: Array<{
    name: string | null;
    issuer: string | null;
    dates: string | null;
  }>;
  recentPosts: Array<{
    text: string | null;
    postedAt: string | null;
    hasImage: boolean;
  }>;
  recentComments: Array<{
    text: string | null;
    postedAt: string | null;
    onPostBy: string | null;
  }>;
  recentReactions: Array<{
    text: string | null;
    postedAt: string | null;
    reaction: string | null;
    onPostBy: string | null;
  }>;
  mutualNames: string[];
}

export interface ExtractionFailure {
  failed: true;
  /**
   * `selectors_outdated`: the parser ran successfully against the page
   * but couldn't locate the stable anchors it expects (top-card section
   * with the owner's name + Contact info marker). Surfaced as a distinct
   * reason so the dashboard / audit log can flag a LinkedIn UI change
   * instead of mis-attributing it to auth/timeout.
   */
  reason:
    | "private"
    | "not_found"
    | "auth_required"
    | "timeout"
    | "navigation_error"
    | "selectors_outdated"
    | "unknown";
  detail?: string;
}

export type ProfileExtractionResult = ExtractedProfile | ExtractionFailure;

const PHASE_A_TIMEOUT_MS = 20_000;
const PHASE_B_TIMEOUT_MS = 8_000;

/**
 * Visit a LinkedIn profile and extract structured fields. Designed to be
 * called against the same authenticated browser context that the
 * messaging adapter uses — pass in the managed page.
 *
 * Two-phase timeout: Phase A loads the main profile + structured
 * sections under a 20s cap. Phase B navigates to the recent-activity
 * sub-page under a separate 8s cap. A Phase B failure never invalidates
 * Phase A — the recent-activity feed is lower-priority data than the
 * headline / experience / education that downstream prompts rely on.
 *
 * Section parsing is defensive: a missing section logs and returns
 * empty/null, never throws. Auth-wall and private-profile pages are
 * detected on URL + DOM and surfaced as a structured failure so the
 * queue can record the reason and move on.
 */
export async function extractProfile(page: Page, profileUrl: string): Promise<ProfileExtractionResult> {
  const phaseA = await runWithTimeout(
    PHASE_A_TIMEOUT_MS,
    () => extractMainProfile(page, profileUrl),
    "phase_a"
  );
  if (phaseA.kind === "timeout") {
    return { failed: true, reason: "timeout", detail: "phase_a" };
  }
  if (phaseA.kind === "error") {
    return classifyError(phaseA.error);
  }
  if ("failed" in phaseA.value && phaseA.value.failed) {
    return phaseA.value;
  }

  const profile = phaseA.value as ExtractedProfile;

  const phaseB = await runWithTimeout(
    PHASE_B_TIMEOUT_MS,
    () => extractRecentPosts(page, profileUrl),
    "phase_b"
  );
  if (phaseB.kind === "ok") {
    profile.recentPosts = phaseB.value;
  } else {
    console.warn(
      `[linkedin-profile-adapter] phase B (recent posts) failed for ${profileUrl}: ${
        phaseB.kind === "timeout" ? "timeout" : phaseB.error instanceof Error ? phaseB.error.message : String(phaseB.error)
      }`
    );
    profile.recentPosts = [];
  }

  const phaseB2 = await runWithTimeout(
    PHASE_B_TIMEOUT_MS,
    () => extractRecentComments(page, profileUrl),
    "phase_b2"
  );
  if (phaseB2.kind === "ok") {
    profile.recentComments = phaseB2.value;
  } else {
    console.warn(
      `[linkedin-profile-adapter] phase B2 (recent comments) failed for ${profileUrl}: ${
        phaseB2.kind === "timeout" ? "timeout" : phaseB2.error instanceof Error ? phaseB2.error.message : String(phaseB2.error)
      }`
    );
    profile.recentComments = [];
  }

  const phaseB3 = await runWithTimeout(
    PHASE_B_TIMEOUT_MS,
    () => extractRecentReactions(page, profileUrl),
    "phase_b3"
  );
  if (phaseB3.kind === "ok") {
    profile.recentReactions = phaseB3.value;
  } else {
    console.warn(
      `[linkedin-profile-adapter] phase B3 (recent reactions) failed for ${profileUrl}: ${
        phaseB3.kind === "timeout" ? "timeout" : phaseB3.error instanceof Error ? phaseB3.error.message : String(phaseB3.error)
      }`
    );
    profile.recentReactions = [];
  }

  return profile;
}

type WrappedResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "timeout" }
  | { kind: "error"; error: unknown };

async function runWithTimeout<T>(
  ms: number,
  work: () => Promise<T>,
  label: string
): Promise<WrappedResult<T>> {
  void label;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<WrappedResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
  });
  try {
    const value = await Promise.race([
      work().then<WrappedResult<T>, WrappedResult<T>>(
        (v) => ({ kind: "ok", value: v }),
        (error) => ({ kind: "error", error })
      ),
      timeoutPromise
    ]);
    return value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classifyError(error: unknown): ExtractionFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (/auth.?wall|login|checkpoint|challenge/i.test(message)) {
    return { failed: true, reason: "auth_required", detail: message };
  }
  if (/timeout/i.test(message)) {
    return { failed: true, reason: "timeout", detail: message };
  }
  if (/net::|navigation/i.test(message)) {
    return { failed: true, reason: "navigation_error", detail: message };
  }
  return { failed: true, reason: "unknown", detail: message };
}

// URL patterns that LinkedIn redirects to when the session isn't
// authenticated: the join page (/signup), the sign-in page (/login,
// /uas/login), checkpoint flows, and the generic /authwall interstitial.
// Both the warmup goto and the eventual profile goto are checked
// against this regex; either landing here is a hard auth_required.
const AUTH_GATE_REDIRECT = /\/(login|checkpoint|authwall|uas\/login|signup)/;

async function extractMainProfile(page: Page, profileUrl: string): Promise<ProfileExtractionResult> {
  // Warm the session before going to the profile URL. Profile pages are
  // an aggressive auth-gate target — /in/<slug>/ tends to redirect to
  // /authwall on a cold context even when /messaging works fine. We
  // first navigate to /feed/, check what URL we land on, and bail out
  // with `auth_required` if the warmup itself was redirected. This both
  // (a) gives the runner a fast-fail when logged out (instead of
  // wasting a profile goto + DOM evaluate), and (b) primes the session
  // cookies so the subsequent profile goto reuses an authenticated
  // state. The /messaging path that the scan uses is also accepted as
  // healthy if a previous scan navigated there.
  await page.goto("https://www.linkedin.com/feed/", {
    waitUntil: "domcontentloaded",
    timeout: 12_000
  }).catch(() => undefined);
  await humanDelay(300, 700);
  const warmupUrl = (page.url() ?? "").toLowerCase();
  if (AUTH_GATE_REDIRECT.test(warmupUrl)) {
    return {
      failed: true,
      reason: "auth_required",
      detail: `feed warmup redirected to ${warmupUrl}`
    };
  }
  // If the warmup landed somewhere unexpected (network issue, LinkedIn
  // error page) but didn't redirect to an auth gate, still try the
  // profile — better to attempt and fail with concrete extraction
  // signals than to refuse pre-emptively.

  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await humanDelay(400, 900);

  const currentUrl = (page.url() ?? "").toLowerCase();
  if (AUTH_GATE_REDIRECT.test(currentUrl)) {
    return { failed: true, reason: "auth_required", detail: `redirected to ${currentUrl}` };
  }

  // Detect explicit "page not found" / "profile unavailable" interstitials.
  // LinkedIn renders these as text rather than a 4xx, so the URL alone
  // doesn't tell us — check the DOM for the canonical strings.
  const pageState = await page
    .evaluate(() => {
      const text = (document.body?.innerText ?? "").toLowerCase();
      return {
        hasNotFound: /this profile is not available|profile not found|page not found/.test(text),
        hasPrivate: /this profile is private|to view this profile|sign in to view/.test(text)
      };
    })
    .catch(() => ({ hasNotFound: false, hasPrivate: false }));

  if (pageState.hasNotFound) {
    return { failed: true, reason: "not_found" };
  }
  if (pageState.hasPrivate && !currentUrl.includes("/in/")) {
    // We may still be on /in/<handle> with a partial public view — only
    // flag private when LinkedIn has hidden the profile entirely.
    return { failed: true, reason: "private" };
  }

  const raw = await page
    .evaluate(() => {
      function clean(value: string | null | undefined): string {
        return (value ?? "").replace(/\s+/g, " ").trim();
      }

      // ----- Stable anchors -----
      // LinkedIn's CSS class names are now build-hashed (`_384a5d29 …`) and
      // semantic tags like `<h1>`, `.text-heading-xlarge`, `section[id="experience"]`
      // no longer exist on profile pages. We anchor on three things that
      // *do* survive: (a) the page title, (b) the URL slug, (c) the visible
      // section headings (`<h2>` text). Selectors that depend on hashed
      // classes are intentionally avoided.

      const ownerName = clean((document.title || "").replace(/\s*\|\s*LinkedIn.*$/i, ""));
      const slug = (location.pathname.match(/\/in\/([^/]+)/) || [])[1] || "";

      function findSectionByH2(label: string): HTMLElement | null {
        const sections = Array.from(document.querySelectorAll("section"));
        return (sections.find((s) => {
          const h2 = s.querySelector("h2") as HTMLElement | null;
          if (!h2) return false;
          const t = (h2.innerText || "").trim();
          // Skills heading is rendered as "Skills (15)" — match the prefix.
          return t === label || t.startsWith(`${label} (`);
        }) ?? null) as HTMLElement | null;
      }

      // Top card: the section that holds the owner's name AND profile-owner
      // markers (Contact info / "X mutual connections"). Distinguished from
      // the Activity section (which contains the owner's name in post
      // attributions but no Contact info) and the Interests section (which
      // contains other people's follower counts).
      const sections = Array.from(document.querySelectorAll("section"));
      let topCard: HTMLElement | null = null;
      for (const s of sections) {
        const h2 = (s.querySelector("h2") as HTMLElement | null)?.innerText?.trim() ?? "";
        const text = s.innerText || "";
        if (h2 === ownerName || (text.includes(ownerName) && /Contact info/i.test(text))) {
          topCard = s as HTMLElement;
          break;
        }
      }
      if (!topCard) {
        return {
          ownerName,
          slug,
          failedSelectors: true as const,
          textNotFound: (document.body?.innerText ?? "").toLowerCase().includes("page not found")
        };
      }

      // ----- Top-card text parsing -----
      // The top card renders as a vertical list of lines, in this order
      // for a typical profile:
      //   <name> / <pronouns?> / · <degree> / <headline> / <location> / · /
      //   Contact info / <current company?> / <current school?> /
      //   <connection count> / <mutuals string> / <action buttons>
      // We parse innerText line-by-line and extract by predicate. Anchoring
      // on the "Contact info" line lets us locate the owner-affiliation
      // strings (company / school) that follow it.
      const topCardLines = (topCard.innerText || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const nameIdx = topCardLines.findIndex((l) => l === ownerName);
      const linesAfterName = nameIdx >= 0 ? topCardLines.slice(nameIdx + 1, nameIdx + 20) : topCardLines.slice(0, 20);

      // Locations are typically "City[, Region][, Country]" — ASCII-ish
      // letters, spaces, periods, hyphens, apostrophes only. The regex is
      // intentionally strict so that post quotes / sentences with commas
      // don't get mistaken for a location (the previous heuristic had this
      // exact bug on profiles with no location set).
      const locRe = /^[A-Za-z][A-Za-z .'-]{1,40}(?:,\s*[A-Za-z][A-Za-z .'-]{1,40}){0,3}$/;
      // Heuristic skip-list for noise lines on the top card.
      const headlineSkipRe = /^(?:Connect|Message|Follow|More|Open to|Pronouns|She\/Her|He\/Him|They\/Them|Contact info)$/i;
      const trailingMetaRe = /(?:connections?|mutual|followers?)$/i;
      const degreeBadgeRe = /^(?:•|·|\d+(?:st|nd|rd))/;

      let headlineText: string | null = null;
      let locationText: string | null = null;
      for (const line of linesAfterName) {
        if (locRe.test(line) && !locationText) {
          locationText = line;
          continue;
        }
        if (
          !headlineText &&
          line.length > 15 &&
          line.length < 240 &&
          !/^\d/.test(line) &&
          !degreeBadgeRe.test(line) &&
          !headlineSkipRe.test(line) &&
          !trailingMetaRe.test(line)
        ) {
          headlineText = line;
        }
        if (headlineText && locationText) break;
      }

      // currentCompany / currentRole: the lines immediately AFTER
      // "Contact info" on the top card are typically the most recent
      // employer and the school. There's no marker telling them apart, so
      // we take the first one as company and don't try to split a role
      // from the headline.
      let currentCompany: string | null = null;
      const contactIdx = linesAfterName.findIndex((l) => /^Contact info$/i.test(l));
      if (contactIdx >= 0) {
        const afterContact = linesAfterName
          .slice(contactIdx + 1, contactIdx + 4)
          .filter((l) => l.length > 1 && l.length < 120 && !trailingMetaRe.test(l) && !/^Message|^More|^Connect$/i.test(l));
        if (afterContact[0]) currentCompany = afterContact[0];
      }
      // currentRole: derive from headline only if it has " at "; otherwise
      // null. We deliberately do NOT mine the experience list here (its
      // DOM structure is too unstable on the new UI).
      let currentRole: string | null = null;
      if (headlineText && headlineText.includes(" at ")) {
        const [role] = headlineText.split(" at ");
        currentRole = role ? role.trim() : null;
      }

      // ----- Mutual connections -----
      // "Tola, Timi and 53 other mutual connections" → count = 55, names
      // = ["Tola", "Timi"]. Or "X and Y are mutual connections" → count = 2.
      const mutualLine = linesAfterName.find((l) => /\bmutual\s+connections?\b/i.test(l)) ?? "";
      let mutualCount: number | null = null;
      const mutualNames: string[] = [];
      if (mutualLine) {
        const otherMatch = mutualLine.match(/(\d+)\s+other\s+mutual/i);
        const namedPart = mutualLine.split(/\s+and\s+\d+\s+other\s+mutual|\s+are\s+mutual/i)[0];
        const namedNames = namedPart
          ? namedPart
              .split(/\s*,\s*|\s+and\s+/)
              .map((n) => n.trim())
              .filter((n) => n && /^[A-Za-z]/.test(n))
          : [];
        mutualNames.push(...namedNames.slice(0, 6));
        if (otherMatch && otherMatch[1]) {
          mutualCount = mutualNames.length + parseInt(otherMatch[1], 10);
        } else if (mutualNames.length > 0) {
          mutualCount = mutualNames.length;
        }
      }

      // ----- Followers (Activity section) -----
      // The owner's follower count is in the Activity section subtitle
      // ("646 followers"). We deliberately do NOT fall back to a
      // document-wide regex — that previously matched the Interests
      // section's Top Voice cards (e.g. "Steven Bartlett · 3,130,476
      // followers") and persisted that as the operator's count.
      let followersCount: number | null = null;
      const activity = findSectionByH2("Activity");
      if (activity) {
        const m = (activity.innerText || "").match(/([\d.,]+)\s*([KMB]?)\s+followers?/i);
        if (m && m[1]) {
          const base = parseFloat(m[1].replace(/,/g, ""));
          if (Number.isFinite(base)) {
            const suf = (m[2] || "").toUpperCase();
            const mul = suf === "K" ? 1_000 : suf === "M" ? 1_000_000 : suf === "B" ? 1_000_000_000 : 1;
            followersCount = Math.round(base * mul);
          }
        }
      }

      // ----- About -----
      // Whole-section innerText with the leading "About" h2 stripped.
      // The new UI doesn't expose the visible-text element via any stable
      // class, but the section's full text is just the h2 + body, so a
      // prefix-strip is reliable.
      let aboutText: string | null = null;
      const aboutSection = findSectionByH2("About");
      if (aboutSection) {
        const t = (aboutSection.innerText || "").trim();
        const stripped = t.replace(/^About\s*\n?/i, "").trim();
        if (stripped) aboutText = stripped;
      }

      // ----- Experience / Education / Skills / Licenses -----
      // The new UI replaced semantic <li> rows with hashed-class <div>
      // sub-components, and there's no stable structural marker for an
      // entry boundary. Doing this reliably is a bigger DOM-exploration
      // exercise — left for a follow-up. We surface presence-only signals
      // here (a flag the AI prompts can use later) and return empty
      // arrays for now, which is honest rather than fabricating partial
      // structured data.
      const presence = {
        experience: !!findSectionByH2("Experience"),
        education: !!findSectionByH2("Education"),
        skills: !!findSectionByH2("Skills"),
        licenses: !!findSectionByH2("Licenses & certifications")
      };

      const textNotFound = (document.body?.innerText ?? "").toLowerCase().includes("page not found");

      return {
        ownerName,
        slug,
        failedSelectors: false as const,
        headline: headlineText,
        about: aboutText,
        location: locationText,
        currentRole,
        currentCompany,
        experience: [] as Array<{ title: string | null; company: string | null; dates: string | null; description: string | null }>,
        education: [] as Array<{ institution: string | null; degree: string | null; field: string | null; dates: string | null }>,
        skills: [] as string[],
        services: [] as string[],
        licenses: [] as Array<{ name: string | null; issuer: string | null; dates: string | null }>,
        followersCount,
        mutualCount,
        mutualNames,
        presence,
        textNotFound
      };
    })
    .catch(() => null);

  if (!raw) {
    return { failed: true, reason: "navigation_error", detail: "evaluate returned null" };
  }
  if (raw.textNotFound) {
    return { failed: true, reason: "not_found" };
  }
  // Fail-loud guard. The previous parser had a fallback that matched the
  // first "X followers" anywhere on the page when the topCard selectors
  // missed; that fed sidebar-recommendation counts (e.g. 39,454 for a
  // person whose real count was 694) into the DB. Better to write nothing
  // and surface a clear "selectors_outdated" reason than to persist
  // partial-and-wrong data.
  if (raw.failedSelectors) {
    return {
      failed: true,
      reason: "selectors_outdated",
      detail: `top card not found for ${raw.ownerName || "(unknown)"} at ${raw.slug || "(no slug)"}`
    };
  }
  // Even with a topCard, if nothing meaningful came out, treat as failure
  // rather than write a row with only follower count populated.
  if (!raw.headline && !raw.about && raw.followersCount == null) {
    return {
      failed: true,
      reason: "selectors_outdated",
      detail: "top card found but no headline/about/followers extracted"
    };
  }

  return {
    headline: raw.headline ? safeTruncate(cleanText(raw.headline), 240) : null,
    about: raw.about ? safeTruncate(cleanText(raw.about), 4_000) : null,
    location: raw.location ? safeTruncate(cleanText(raw.location), 200) : null,
    currentCompany: raw.currentCompany ? safeTruncate(cleanText(raw.currentCompany), 160) : null,
    currentRole: raw.currentRole ? safeTruncate(cleanText(raw.currentRole), 160) : null,
    mutualCount: typeof raw.mutualCount === "number" && Number.isFinite(raw.mutualCount) ? raw.mutualCount : null,
    followersCount: typeof raw.followersCount === "number" && Number.isFinite(raw.followersCount) ? raw.followersCount : null,
    experience: (raw.experience ?? []).map((e) => ({
      title: e.title ? safeTruncate(cleanText(e.title), 160) : null,
      company: e.company ? safeTruncate(cleanText(e.company), 160) : null,
      dates: e.dates ? safeTruncate(cleanText(e.dates), 80) : null,
      description: e.description ? safeTruncate(cleanText(e.description), 600) : null
    })),
    education: (raw.education ?? []).map((e) => ({
      institution: e.institution ? safeTruncate(cleanText(e.institution), 160) : null,
      degree: e.degree ? safeTruncate(cleanText(e.degree), 120) : null,
      field: e.field ? safeTruncate(cleanText(e.field), 120) : null,
      dates: e.dates ? safeTruncate(cleanText(e.dates), 80) : null
    })),
    skills: (raw.skills ?? []).slice(0, 12).map((s) => safeTruncate(cleanText(s), 120)),
    services: (raw.services ?? []).slice(0, 8).map((s) => safeTruncate(cleanText(s), 120)),
    licenses: (raw.licenses ?? []).slice(0, 10).map((l) => ({
      name: l.name ? safeTruncate(cleanText(l.name), 160) : null,
      issuer: l.issuer ? safeTruncate(cleanText(l.issuer), 160) : null,
      dates: l.dates ? safeTruncate(cleanText(l.dates), 80) : null
    })),
    recentPosts: [],
    recentComments: [],
    recentReactions: [],
    mutualNames: (raw.mutualNames ?? []).slice(0, 8).map((s) => safeTruncate(cleanText(s), 120))
  };
}

async function extractRecentPosts(
  page: Page,
  profileUrl: string
): Promise<ExtractedProfile["recentPosts"]> {
  const activityUrl = profileUrl.replace(/\/$/, "") + "/recent-activity/all/";
  await page.goto(activityUrl, { waitUntil: "domcontentloaded", timeout: 7_000 });
  await humanDelay(300, 600);

  const items = await page
    .evaluate(() => {
      function clean(value: string | null | undefined): string {
        return (value ?? "").replace(/\s+/g, " ").trim();
      }
      const cards = Array.from(
        document.querySelectorAll(".feed-shared-update-v2, .occludable-update, .scaffold-finite-scroll__content > div")
      ).slice(0, 8);
      return cards
        .map((card) => {
          const textNode = card.querySelector(".update-components-text, .feed-shared-update-v2__description") as HTMLElement | null;
          const text = textNode ? clean(textNode.innerText) : "";
          const dateNode = card.querySelector("time, .update-components-actor__sub-description span[aria-hidden='true']") as HTMLElement | null;
          const postedAt = dateNode ? clean(dateNode.innerText) : null;
          const hasImage = Boolean(card.querySelector("img.update-components-image__image, .update-components-image"));
          return { text, postedAt, hasImage };
        })
        .filter((entry) => entry.text.length > 0);
    })
    .catch(() => []);

  return items.slice(0, 5).map((entry) => ({
    text: entry.text ? safeTruncate(cleanText(entry.text), 600) : null,
    postedAt: entry.postedAt ? safeTruncate(cleanText(entry.postedAt), 80) : null,
    hasImage: Boolean(entry.hasImage)
  }));
}

async function extractRecentComments(
  page: Page,
  profileUrl: string
): Promise<ExtractedProfile["recentComments"]> {
  const url = profileUrl.replace(/\/$/, "") + "/recent-activity/comments/";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 7_000 });
  await humanDelay(300, 600);

  const items = await page
    .evaluate(() => {
      function clean(value: string | null | undefined): string {
        return (value ?? "").replace(/\s+/g, " ").trim();
      }
      const cards = Array.from(
        document.querySelectorAll(".feed-shared-update-v2, .occludable-update, .scaffold-finite-scroll__content > div")
      ).slice(0, 10);
      return cards
        .map((card) => {
          const commentNode = card.querySelector(".comments-comment-item__main-content, .update-components-text") as HTMLElement | null;
          const text = commentNode ? clean(commentNode.innerText) : "";
          const onPostByNode = card.querySelector(".update-components-actor__title span[aria-hidden='true'], .feed-shared-actor__name") as HTMLElement | null;
          const onPostBy = onPostByNode ? clean(onPostByNode.innerText) : null;
          const dateNode = card.querySelector("time, .update-components-actor__sub-description span[aria-hidden='true']") as HTMLElement | null;
          const postedAt = dateNode ? clean(dateNode.innerText) : null;
          return { text, postedAt, onPostBy };
        })
        .filter((entry) => entry.text.length > 0);
    })
    .catch(() => []);

  return items.slice(0, 8).map((entry) => ({
    text: entry.text ? safeTruncate(cleanText(entry.text), 600) : null,
    postedAt: entry.postedAt ? safeTruncate(cleanText(entry.postedAt), 80) : null,
    onPostBy: entry.onPostBy ? safeTruncate(cleanText(entry.onPostBy), 160) : null
  }));
}

async function extractRecentReactions(
  page: Page,
  profileUrl: string
): Promise<ExtractedProfile["recentReactions"]> {
  const url = profileUrl.replace(/\/$/, "") + "/recent-activity/reactions/";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 7_000 });
  await humanDelay(300, 600);

  const items = await page
    .evaluate(() => {
      function clean(value: string | null | undefined): string {
        return (value ?? "").replace(/\s+/g, " ").trim();
      }
      const cards = Array.from(
        document.querySelectorAll(".feed-shared-update-v2, .occludable-update, .scaffold-finite-scroll__content > div")
      ).slice(0, 10);
      return cards
        .map((card) => {
          const textNode = card.querySelector(".update-components-text, .feed-shared-update-v2__description") as HTMLElement | null;
          const text = textNode ? clean(textNode.innerText) : "";
          const headerNode = card.querySelector(".update-components-header__text-view, .update-components-header") as HTMLElement | null;
          const headerText = headerNode ? clean(headerNode.innerText) : "";
          // "<Name> liked this" / "<Name> celebrates this" — strip name
          // and keep the verb as the reaction label.
          const reactionMatch = headerText.match(/(liked|loved|celebrated|supported|insightful|funny|curious)/i);
          const reaction = reactionMatch ? reactionMatch[1]!.toLowerCase() : null;
          const onPostByNode = card.querySelector(".update-components-actor__title span[aria-hidden='true'], .feed-shared-actor__name") as HTMLElement | null;
          const onPostBy = onPostByNode ? clean(onPostByNode.innerText) : null;
          const dateNode = card.querySelector("time, .update-components-actor__sub-description span[aria-hidden='true']") as HTMLElement | null;
          const postedAt = dateNode ? clean(dateNode.innerText) : null;
          return { text, postedAt, reaction, onPostBy };
        })
        .filter((entry) => entry.text.length > 0 || entry.reaction !== null);
    })
    .catch(() => []);

  return items.slice(0, 8).map((entry) => ({
    text: entry.text ? safeTruncate(cleanText(entry.text), 400) : null,
    postedAt: entry.postedAt ? safeTruncate(cleanText(entry.postedAt), 80) : null,
    reaction: entry.reaction ? safeTruncate(cleanText(entry.reaction), 40) : null,
    onPostBy: entry.onPostBy ? safeTruncate(cleanText(entry.onPostBy), 160) : null
  }));
}
