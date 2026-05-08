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
  reason: "private" | "not_found" | "auth_required" | "timeout" | "navigation_error" | "unknown";
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

async function extractMainProfile(page: Page, profileUrl: string): Promise<ProfileExtractionResult> {
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await humanDelay(400, 900);

  const currentUrl = (page.url() ?? "").toLowerCase();
  if (/\/(login|checkpoint|authwall|uas\/login)/.test(currentUrl)) {
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

      function textOf(selector: string): string | null {
        const node = document.querySelector(selector);
        return node ? clean((node as HTMLElement).innerText) : null;
      }

      // Top card. Headline is the line under the name. Location is the
      // small subtitle. Both have moved class names over the years —
      // anchor on `text-heading-xlarge` for the name, then walk to the
      // siblings for headline + location.
      const nameNode = document.querySelector(".text-heading-xlarge, h1.top-card-layout__title, h1");
      const topCard = nameNode?.closest("section, div");
      const headlineText = topCard
        ? clean(
            (topCard.querySelector(".text-body-medium.break-words") as HTMLElement | null)?.innerText ??
              (topCard.querySelector(".top-card-layout__headline") as HTMLElement | null)?.innerText ??
              ""
          )
        : "";
      const locationText = topCard
        ? clean(
            (
              topCard.querySelector(".text-body-small.inline.t-black--light.break-words") as HTMLElement | null
            )?.innerText ?? ""
          )
        : "";

      // About section. Aria-labelled or id-prefixed.
      const aboutSection = document.querySelector(
        'section[id*="about"], section[data-section="summary"], div#about'
      );
      const aboutText = aboutSection
        ? clean((aboutSection.querySelector(".display-flex span, .pv-shared-text-with-see-more, .core-section-container__content") as HTMLElement | null)?.innerText ??
            (aboutSection as HTMLElement).innerText)
        : "";

      function listItemsIn(sectionSelector: string): HTMLElement[] {
        const section = document.querySelector(sectionSelector);
        if (!section) return [];
        const items = Array.from(section.querySelectorAll("li.artdeco-list__item, li.pvs-list__paged-list-item, li"));
        return items as HTMLElement[];
      }

      // Experience: each <li> has a title, company-and-employment-type
      // span, dates span, and a free-text description further down.
      const experienceItems = listItemsIn('section[id*="experience"]').slice(0, 8).map((node) => {
        const lines = clean(node.innerText).split(" · ");
        const title = lines[0] ?? null;
        const companyLine = (node.querySelector("span.t-14.t-normal") as HTMLElement | null)?.innerText ?? "";
        const company = clean(companyLine.split(" · ")[0] ?? null);
        const datesLine = (node.querySelector("span.t-14.t-normal.t-black--light, .pvs-entity__caption-wrapper") as HTMLElement | null)?.innerText ?? "";
        const dates = clean(datesLine);
        const description = (node.querySelector(".inline-show-more-text, .pv-shared-text-with-see-more") as HTMLElement | null)?.innerText ?? null;
        return {
          title,
          company: company || null,
          dates: dates || null,
          description: description ? clean(description) : null
        };
      });

      const educationItems = listItemsIn('section[id*="education"]').slice(0, 6).map((node) => {
        const institution = (node.querySelector("span.mr1.t-bold span, span.mr1.hoverable-link-text span") as HTMLElement | null)?.innerText ?? null;
        const degreeLine = (node.querySelector("span.t-14.t-normal span") as HTMLElement | null)?.innerText ?? "";
        const datesLine = (node.querySelector(".pvs-entity__caption-wrapper, span.t-14.t-normal.t-black--light span") as HTMLElement | null)?.innerText ?? "";
        const [degree = "", field = ""] = clean(degreeLine).split(", ");
        return {
          institution: institution ? clean(institution) : null,
          degree: degree || null,
          field: field || null,
          dates: clean(datesLine) || null
        };
      });

      const skillItems = listItemsIn('section[id*="skills"]').slice(0, 12).map((node) => {
        const label = (node.querySelector("span.mr1.t-bold span, span.mr1.hoverable-link-text span") as HTMLElement | null)?.innerText ?? null;
        return label ? clean(label) : null;
      }).filter((s): s is string => Boolean(s));

      const serviceItems = listItemsIn('section[id*="services"]').slice(0, 8).map((node) => {
        return clean((node.querySelector("span.t-14") as HTMLElement | null)?.innerText ?? node.innerText);
      }).filter((s) => s.length > 0 && s.length < 80);

      // Licenses & certifications. Same structural pattern as experience:
      // <li> with a bold name span, an issuer line, and a dates caption.
      const licenseItems = listItemsIn('section[id*="licenses"], section[id*="certifications"]').slice(0, 10).map((node) => {
        const name = (node.querySelector("span.mr1.t-bold span, span.mr1.hoverable-link-text span, span.t-bold span") as HTMLElement | null)?.innerText ?? null;
        const issuer = (node.querySelector("span.t-14.t-normal span") as HTMLElement | null)?.innerText ?? null;
        const dates = (node.querySelector(".pvs-entity__caption-wrapper, span.t-14.t-normal.t-black--light span") as HTMLElement | null)?.innerText ?? null;
        return {
          name: name ? clean(name) : null,
          issuer: issuer ? clean(issuer) : null,
          dates: dates ? clean(dates) : null
        };
      }).filter((item) => item.name);

      // Followers count appears on the top card as "<N> followers" — small
      // muted text, sometimes a link. Match defensively because LinkedIn
      // localises the number with thousand separators ("1,234") and an
      // optional "K" suffix ("3K followers" on profile cards).
      let followersCount: number | null = null;
      const followersScopes: Element[] = [topCard, document.body].filter((n): n is Element => Boolean(n));
      for (const scope of followersScopes) {
        const text = clean((scope as HTMLElement).innerText ?? "");
        const match = text.match(/([\d.,]+)\s*([KMB]?)\s+followers/i);
        if (match && match[1]) {
          const base = parseFloat(match[1].replace(/,/g, ""));
          if (Number.isFinite(base)) {
            const suffix = (match[2] || "").toUpperCase();
            const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
            followersCount = Math.round(base * multiplier);
            break;
          }
        }
      }

      // Mutual connections appear as a small badge near the top of the
      // profile, e.g. "12 mutual connections, including Alice and Bob".
      const mutualNode = document.querySelector('a[href*="mutualConnections"], a[href*="facetNetwork"]');
      const mutualText = mutualNode ? clean((mutualNode as HTMLElement).innerText) : "";
      const mutualCountMatch = mutualText.match(/(\d+)\s+mutual/);
      const mutualCount = mutualCountMatch && mutualCountMatch[1] ? parseInt(mutualCountMatch[1], 10) : null;
      const mutualNamesMatch = mutualText.match(/including\s+(.+)$/);
      const mutualNames = mutualNamesMatch && mutualNamesMatch[1]
        ? mutualNamesMatch[1].split(/, |,| and /).map((n: string) => clean(n)).filter((n: string) => n.length > 0)
        : [];

      // Current role + company are derived from the most recent
      // experience entry (top of the list). Fall back to splitting the
      // headline on " at " when the experience section is hidden.
      let currentRole: string | null = experienceItems[0]?.title ?? null;
      let currentCompany: string | null = experienceItems[0]?.company ?? null;
      if (!currentRole && headlineText.includes(" at ")) {
        const [role, company] = headlineText.split(" at ");
        currentRole = role ? clean(role) : null;
        currentCompany = company ? clean(company) : null;
      }

      return {
        headline: headlineText || null,
        about: aboutText || null,
        location: locationText || null,
        currentRole,
        currentCompany,
        experience: experienceItems,
        education: educationItems,
        skills: skillItems,
        services: serviceItems,
        licenses: licenseItems,
        followersCount,
        mutualCount,
        mutualNames,
        textNotFound: textOf("body")?.toLowerCase().includes("page not found") ?? false
      };
    })
    .catch(() => null);

  if (!raw) {
    return { failed: true, reason: "navigation_error", detail: "evaluate returned null" };
  }
  if (raw.textNotFound) {
    return { failed: true, reason: "not_found" };
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
