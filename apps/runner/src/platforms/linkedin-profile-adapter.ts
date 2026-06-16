import type { Page } from "patchright";
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
    () => extractMainProfile(page, profileUrl)
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
    () => extractRecentPosts(page, profileUrl)
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
    () => extractRecentComments(page, profileUrl)
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
    () => extractRecentReactions(page, profileUrl)
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
  work: () => Promise<T>
): Promise<WrappedResult<T>> {
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

  // Expand any "...see more" toggle inside the About section so the full
  // body text is in the rendered DOM before we read it. LinkedIn truncates
  // long About sections behind a click; without this step the extracted
  // about ends mid-sentence at the truncation point.
  await page
    .evaluate(() => {
      const sections = Array.from(document.querySelectorAll("section"));
      const aboutSection = sections.find((s) => {
        const h2 = s.querySelector("h2") as HTMLElement | null;
        return h2 ? (h2.innerText || "").trim() === "About" : false;
      });
      if (!aboutSection) return;
      const buttons = Array.from(aboutSection.querySelectorAll("button"));
      for (const btn of buttons) {
        const label = ((btn as HTMLElement).innerText || btn.textContent || "")
          .trim()
          .toLowerCase();
        if (/see\s+more\b/.test(label) || /\bmore\b$/.test(label)) {
          try {
            (btn as HTMLElement).click();
          } catch {
            // ignore — fall back to whatever text is already in DOM
          }
        }
      }
    })
    .catch(() => undefined);
  await humanDelay(150, 350);

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
      //
      // For long About sections LinkedIn renders both a truncated visible
      // span and a screen-reader-only span containing the full body. The
      // pre-evaluate step clicks "see more" to reveal the full text, but
      // we also fall back to picking whichever candidate is longest in
      // case the click was a no-op or the structure changes.
      let aboutText: string | null = null;
      const aboutSection = findSectionByH2("About");
      if (aboutSection) {
        const candidates: string[] = [];
        const stripped = (aboutSection.innerText || "")
          .trim()
          .replace(/^About\s*\n?/i, "")
          .replace(/\s*\.{2,}\s*see\s+more\s*$/i, "")
          .replace(/\s*see\s+more\s*$/i, "")
          .trim();
        if (stripped) candidates.push(stripped);
        const hiddenSpans = aboutSection.querySelectorAll<HTMLElement>(
          'span.visually-hidden, span[class*="visually-hidden"]'
        );
        for (const s of Array.from(hiddenSpans)) {
          const t = (s.textContent || "").trim();
          if (t.length > 40 && !/^About$/i.test(t)) candidates.push(t);
        }
        candidates.sort((a, b) => b.length - a.length);
        if (candidates[0]) aboutText = candidates[0];
      }

      // Experience / Education / Skills / Services / Licenses are parsed by
      // extractProfileSections() in a separate pass (see below). Splitting
      // the structural section parser out of this top-card evaluate lets it
      // be unit-tested against DOM fixtures in isolation; this evaluate
      // intentionally stops at the header / top-card fields.

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
        followersCount,
        mutualCount,
        mutualNames,
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

  // Structured sections (experience / education / skills / services /
  // licenses) are parsed in a separate pass on the same loaded page. A
  // null result (evaluate threw) degrades to empty arrays — the top-card
  // fields above are still worth persisting on their own.
  const sections = (await extractProfileSections(page)) ?? {
    experience: [],
    education: [],
    skills: [],
    services: [],
    licenses: [],
    presence: { experience: false, education: false, skills: false, services: false, licenses: false }
  };
  // Fail loud, don't fabricate: if a section heading is present but the
  // structural parser pulled zero entries, LinkedIn's per-entry DOM has
  // likely shifted. Log it and keep the array empty rather than guessing.
  for (const key of ["experience", "education", "skills", "services", "licenses"] as const) {
    if (sections.presence[key] && (sections[key] as unknown[]).length === 0) {
      console.warn(
        `[linkedin-profile-adapter] "${key}" section present but 0 entries parsed for ${raw.slug || profileUrl} — selectors may be outdated (kept empty, not fabricated)`
      );
    }
  }

  return {
    headline: raw.headline ? safeTruncate(cleanText(raw.headline), 240) : null,
    about: raw.about ? safeTruncate(cleanText(raw.about), 4_000) : null,
    location: raw.location ? safeTruncate(cleanText(raw.location), 200) : null,
    currentCompany: raw.currentCompany ? safeTruncate(cleanText(raw.currentCompany), 160) : null,
    currentRole: raw.currentRole ? safeTruncate(cleanText(raw.currentRole), 160) : null,
    mutualCount: typeof raw.mutualCount === "number" && Number.isFinite(raw.mutualCount) ? raw.mutualCount : null,
    followersCount: typeof raw.followersCount === "number" && Number.isFinite(raw.followersCount) ? raw.followersCount : null,
    experience: (sections.experience ?? []).map((e) => ({
      title: e.title ? safeTruncate(cleanText(e.title), 160) : null,
      company: e.company ? safeTruncate(cleanText(e.company), 160) : null,
      dates: e.dates ? safeTruncate(cleanText(e.dates), 80) : null,
      description: e.description ? safeTruncate(cleanText(e.description), 600) : null
    })),
    education: (sections.education ?? []).map((e) => ({
      institution: e.institution ? safeTruncate(cleanText(e.institution), 160) : null,
      degree: e.degree ? safeTruncate(cleanText(e.degree), 120) : null,
      field: e.field ? safeTruncate(cleanText(e.field), 120) : null,
      dates: e.dates ? safeTruncate(cleanText(e.dates), 80) : null
    })),
    skills: (sections.skills ?? []).slice(0, 12).map((s) => safeTruncate(cleanText(s), 120)),
    services: (sections.services ?? []).slice(0, 8).map((s) => safeTruncate(cleanText(s), 120)),
    licenses: (sections.licenses ?? []).slice(0, 10).map((l) => ({
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

export interface ProfileSections {
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
  licenses: Array<{ name: string | null; issuer: string | null; dates: string | null }>;
  presence: {
    experience: boolean;
    education: boolean;
    skills: boolean;
    services: boolean;
    licenses: boolean;
  };
}

/**
 * Parse the structured profile sections (Experience, Education, Skills,
 * Services, Licenses & certifications) from an already-loaded profile
 * page. Runs as its own `page.evaluate` so it can be unit-tested against
 * DOM fixtures in isolation — production calls it from extractMainProfile
 * once the profile page is loaded; it performs no navigation of its own.
 *
 * The parser is purely structural and uses no hashed class names:
 *  - sections are located by their <h2> heading text;
 *  - entries are the top-level <li> rows under a section (nested sub-role
 *    and description <li>s are excluded);
 *  - each entry's visible lines are read from `span[aria-hidden="true"]`
 *    whose nearest <li> ancestor is the entry itself (LinkedIn renders
 *    each line as a visible aria-hidden span plus an off-screen
 *    `.visually-hidden` twin — reading only the aria-hidden side avoids
 *    duplicates).
 *
 * It deliberately never fabricates: a present-but-unparseable section
 * yields an empty array (the caller logs a fail-loud warning). Returns
 * null only if the evaluate itself throws.
 */
export async function extractProfileSections(page: Page): Promise<ProfileSections | null> {
  return page
    .evaluate(() => {
      function clean(value: string | null | undefined): string {
        return (value ?? "").replace(/\s+/g, " ").trim();
      }

      function findSectionByH2(label: string): HTMLElement | null {
        const sections = Array.from(document.querySelectorAll("section"));
        return (sections.find((s) => {
          const h2 = s.querySelector("h2") as HTMLElement | null;
          if (!h2) return false;
          const t = (h2.innerText || "").trim();
          // Headings can carry a count suffix, e.g. "Skills (15)".
          return t === label || t.startsWith(`${label} (`);
        }) ?? null) as HTMLElement | null;
      }

      // A line is a "date" line if it carries a 4-digit year or "Present".
      const dateRe = /\b(?:19|20)\d{2}\b|\bpresent\b/i;

      // Top-level entry rows under a section: <li>s that hold at least one
      // header span and are not themselves nested inside another <li> of
      // the same section (which excludes grouped sub-roles and the
      // description bullet list).
      function entryItems(section: HTMLElement): HTMLElement[] {
        const lis = Array.from(section.querySelectorAll("li")) as HTMLElement[];
        return lis.filter((li) => {
          if (!li.querySelector('span[aria-hidden="true"]') && textLines(li).length === 0) return false;
          const parentLi = li.parentElement ? li.parentElement.closest("li") : null;
          if (parentLi && section.contains(parentLi)) return false;
          return true;
        });
      }

      // Visible header lines of a single entry, in document order, with
      // consecutive duplicates collapsed. Only spans whose nearest <li>
      // ancestor is THIS entry count — spans inside nested role/description
      // <li>s are skipped.
      function headerLines(entry: HTMLElement): string[] {
        const spans = Array.from(
          entry.querySelectorAll('span[aria-hidden="true"]')
        ) as HTMLElement[];
        const out: string[] = [];
        for (const s of spans) {
          if (s.closest("li") !== entry) continue;
          const t = clean(s.textContent);
          if (!t) continue;
          if (out.length && out[out.length - 1] === t) continue;
          out.push(t);
        }
        if (out.length > 0) return out;
        for (const line of textLines(entry)) {
          if (out.length && out[out.length - 1] === line) continue;
          out.push(line);
        }
        return out;
      }

      // Free-text role description: the longest aria-hidden blob in the
      // entry that isn't already one of the short header lines.
      function descriptionOf(entry: HTMLElement, used: string[]): string | null {
        const spans = Array.from(
          entry.querySelectorAll('span[aria-hidden="true"]')
        ) as HTMLElement[];
        let best: string | null = null;
        for (const s of spans) {
          const t = clean(s.textContent);
          if (t.length <= 60 || used.includes(t)) continue;
          if (!best || t.length > best.length) best = t;
        }
        if (best) return best;
        for (const t of textLines(entry)) {
          if (t.length <= 60 || used.includes(t)) continue;
          if (!best || t.length > best.length) best = t;
        }
        return best;
      }

      function firstDate(lines: string[]): string | null {
        return lines.find((l) => dateRe.test(l)) ?? null;
      }

      function textLines(element: HTMLElement): string[] {
        return (element.innerText || "")
          .split("\n")
          .map((line) => clean(line))
          .filter(Boolean);
      }

      function sectionBodyLines(section: HTMLElement): string[] {
        const heading = clean((section.querySelector("h2") as HTMLElement | null)?.innerText ?? "");
        return textLines(section).filter((line) => line !== heading);
      }

      // "Acme Corp · Full-time" → "Acme Corp"; "BSc, Computer Science" left
      // intact (only the middot separator is stripped here).
      function beforeMiddot(value: string | null): string | null {
        if (!value) return value;
        const head = value.split(/\s+·\s+/)[0] ?? value;
        return head.trim() || null;
      }

      // Flat list of names for chip-style sections (Skills / Services):
      // one name per entry, falling back to splitting the section body on
      // separators when the section has no <li> rows.
      function nameList(section: HTMLElement | null): string[] {
        if (!section) return [];
        const entries = entryItems(section);
        const names: string[] = [];
        if (entries.length) {
          for (const e of entries) {
            const line = headerLines(e)[0];
            if (line) names.push(line);
          }
        } else {
          const heading = (section.querySelector("h2") as HTMLElement | null)?.innerText ?? "";
          const body = clean((section.innerText || "").replace(heading, ""));
          for (const part of body.split(/\s*[·,\n]\s*/)) {
            const t = clean(part);
            if (t) names.push(t);
          }
        }
        // De-dupe while preserving order.
        const seen = new Set<string>();
        return names.filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
      }

      function parseExperienceEntry(entry: HTMLElement): {
        title: string | null;
        company: string | null;
        dates: string | null;
        description: string | null;
      } | null {
        const lines = headerLines(entry);
        const dates = firstDate(lines);
        const dateIndex = dates ? lines.indexOf(dates) : lines.length;
        const companyLine = lines
          .slice(1, dateIndex)
          .find((line) => !dateRe.test(line)) ?? null;
        const used = [lines[0], companyLine, dates].filter(Boolean) as string[];
        const result = {
          title: lines[0] || null,
          company: beforeMiddot(companyLine),
          dates,
          description: descriptionOf(entry, used)
        };
        return result.title || result.company || result.dates || result.description ? result : null;
      }

      function parseEducationLines(lines: string[]): Array<{
        institution: string | null;
        degree: string | null;
        field: string | null;
        dates: string | null;
      }> {
        const entries: Array<{ institution: string | null; degree: string | null; field: string | null; dates: string | null }> = [];
        for (let i = 0; i < lines.length; i += 1) {
          const dateLine = lines[i] ?? "";
          if (!dateRe.test(dateLine)) continue;
          const previous = lines.slice(Math.max(0, i - 3), i).filter((line) => !dateRe.test(line));
          const institution = previous[0] ?? null;
          const degreeLine = previous[1] ?? null;
          let degree: string | null = degreeLine;
          let field: string | null = null;
          if (degreeLine && degreeLine.includes(",")) {
            const idx = degreeLine.indexOf(",");
            degree = degreeLine.slice(0, idx).trim() || null;
            field = degreeLine.slice(idx + 1).trim() || null;
          }
          entries.push({ institution, degree, field, dates: dateLine });
        }
        return entries.filter((entry) => entry.institution || entry.degree || entry.field || entry.dates);
      }

      function parseLicenseLines(lines: string[]): Array<{ name: string | null; issuer: string | null; dates: string | null }> {
        const entries: Array<{ name: string | null; issuer: string | null; dates: string | null }> = [];
        for (let i = 0; i < lines.length; i += 1) {
          const dateLine = lines[i] ?? "";
          if (!dateRe.test(dateLine)) continue;
          const previous = lines.slice(Math.max(0, i - 2), i).filter((line) => !dateRe.test(line));
          entries.push({
            name: previous[0] ?? null,
            issuer: previous[1] ?? null,
            dates: dateLine
          });
        }
        return entries.filter((entry) => entry.name || entry.issuer || entry.dates);
      }

      function parseEducationEntry(entry: HTMLElement): {
        institution: string | null;
        degree: string | null;
        field: string | null;
        dates: string | null;
      } | null {
        const lines = headerLines(entry);
        const dates = firstDate(lines);
        const degreeLine = lines[1] && !dateRe.test(lines[1]) ? lines[1] : null;
        let degree: string | null = degreeLine;
        let field: string | null = null;
        if (degreeLine && degreeLine.includes(",")) {
          const idx = degreeLine.indexOf(",");
          degree = degreeLine.slice(0, idx).trim() || null;
          field = degreeLine.slice(idx + 1).trim() || null;
        }
        const result = { institution: lines[0] || null, degree, field, dates };
        return result.institution || result.degree || result.field || result.dates ? result : null;
      }

      function parseLicenseEntry(entry: HTMLElement): { name: string | null; issuer: string | null; dates: string | null } | null {
        const lines = headerLines(entry);
        const dates = firstDate(lines);
        const result = {
          name: lines[0] || null,
          issuer: lines[1] && lines[1] !== dates ? lines[1] : null,
          dates
        };
        return result.name || result.issuer || result.dates ? result : null;
      }

      const experienceSection = findSectionByH2("Experience");
      const educationSection = findSectionByH2("Education");
      const skillsSection = findSectionByH2("Skills");
      const servicesSection = findSectionByH2("Services");
      const licensesSection = findSectionByH2("Licenses & certifications");

      const experience = experienceSection
        ? entryItems(experienceSection)
            .map((entry) => parseExperienceEntry(entry))
            .filter((entry): entry is NonNullable<typeof entry> => entry != null)
        : [];

      const education = educationSection
        ? entryItems(educationSection).length > 0
          ? entryItems(educationSection)
              .map((entry) => parseEducationEntry(entry))
              .filter((entry): entry is NonNullable<typeof entry> => entry != null)
          : parseEducationLines(sectionBodyLines(educationSection))
        : [];

      const licenses = licensesSection
        ? entryItems(licensesSection).length > 0
          ? entryItems(licensesSection)
              .map((entry) => parseLicenseEntry(entry))
              .filter((entry): entry is NonNullable<typeof entry> => entry != null)
          : parseLicenseLines(sectionBodyLines(licensesSection))
        : [];

      return {
        experience,
        education,
        skills: nameList(skillsSection),
        services: nameList(servicesSection),
        licenses,
        presence: {
          experience: !!experienceSection,
          education: !!educationSection,
          skills: !!skillsSection,
          services: !!servicesSection,
          licenses: !!licensesSection
        }
      };
    })
    .catch(() => null);
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
      ).slice(0, 14);
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

  return items.slice(0, 10).map((entry) => ({
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
      ).slice(0, 14);
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

  return items.slice(0, 10).map((entry) => ({
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
      ).slice(0, 14);
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

  return items.slice(0, 10).map((entry) => ({
    text: entry.text ? safeTruncate(cleanText(entry.text), 400) : null,
    postedAt: entry.postedAt ? safeTruncate(cleanText(entry.postedAt), 80) : null,
    reaction: entry.reaction ? safeTruncate(cleanText(entry.reaction), 40) : null,
    onPostBy: entry.onPostBy ? safeTruncate(cleanText(entry.onPostBy), 160) : null
  }));
}
