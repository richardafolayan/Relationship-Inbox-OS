import { createHash } from "node:crypto";
import { prisma } from "../db";
import type {
  AiService,
  ContactProfileSnapshot,
  ConversationStarterDraft,
  ConversationStarterCitedField
} from "../types/runtime";
import type { SelfProfileService } from "./self-profile";

/**
 * Output written to the dashboard. `validatedCount` is the number of
 * starters whose citation actually resolves against the contact's
 * enrichment payload — surfaced so the UI can warn when fewer than
 * expected made it through (e.g. "1 starter — model dropped 2").
 */
export interface ConversationStartersResult {
  starters: ConversationStarterDraft[];
  generatedAt: string;
  validatedCount: number;
}

interface PersonEnrichmentRow {
  id: string;
  personId: string;
  headline: string | null;
  about: string | null;
  location: string | null;
  currentCompany: string | null;
  currentRole: string | null;
  mutualCount: number | null;
  experienceJson: string | null;
  educationJson: string | null;
  skillsJson: string | null;
  servicesJson: string | null;
  recentPostsJson: string | null;
  mutualNamesJson: string | null;
  summary: string | null;
  summaryCacheKey: string | null;
  startersJson: string | null;
  startersCacheKey: string | null;
}

interface ConversationStartersDeps {
  aiService: AiService;
  selfProfile: SelfProfileService;
}

export interface ConversationStartersService {
  /** Generate (or return cached) summary for a person, persisting to DB. */
  getOrGenerateSummary(personId: string, displayName: string): Promise<string | null>;
  /** Generate (or return cached) starters for a person, persisting to DB. */
  getOrGenerateStarters(personId: string, displayName: string): Promise<ConversationStartersResult | null>;
  /** Project a PersonEnrichment row to the AI prompt input shape. */
  toContactSnapshot(personId: string, displayName: string): Promise<ContactProfileSnapshot | null>;
}

function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToContactSnapshot(row: PersonEnrichmentRow, displayName: string): ContactProfileSnapshot {
  return {
    displayName,
    headline: row.headline,
    about: row.about,
    location: row.location,
    currentCompany: row.currentCompany,
    currentRole: row.currentRole,
    experience: safeJsonParse(row.experienceJson, [] as ContactProfileSnapshot["experience"]),
    education: safeJsonParse(row.educationJson, [] as ContactProfileSnapshot["education"]),
    skills: safeJsonParse(row.skillsJson, [] as string[]),
    services: safeJsonParse(row.servicesJson, [] as string[]),
    recentPosts: safeJsonParse(row.recentPostsJson, [] as ContactProfileSnapshot["recentPosts"])
  };
}

/**
 * Stable hash over the contact + self snapshots. Stable means: same
 * inputs → same hash regardless of object key ordering, JSON whitespace,
 * or undefined-vs-omitted keys. We sort keys recursively before
 * stringifying to guarantee that.
 */
function stableHash(value: unknown): string {
  function normalise(input: unknown): unknown {
    if (input === null || input === undefined) return null;
    if (Array.isArray(input)) return input.map(normalise);
    if (typeof input === "object") {
      const obj = input as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) {
        const v = obj[key];
        if (v === undefined) continue;
        sorted[key] = normalise(v);
      }
      return sorted;
    }
    return input;
  }
  return createHash("sha256").update(JSON.stringify(normalise(value))).digest("hex");
}

/**
 * Validate that each starter's `citedField` actually corresponds to a
 * non-empty value in the contact's enrichment payload. Catches the
 * model claiming to have used field X while inventing the content. A
 * starter whose citation doesn't resolve is dropped (and logged).
 */
function isFieldPopulated(field: ConversationStarterCitedField, snap: ContactProfileSnapshot): boolean {
  switch (field) {
    case "headline":
      return Boolean(snap.headline && snap.headline.trim().length > 0);
    case "about":
      return Boolean(snap.about && snap.about.trim().length > 0);
    case "location":
      return Boolean(snap.location && snap.location.trim().length > 0);
    case "experience":
      return Array.isArray(snap.experience) && snap.experience.length > 0;
    case "education":
      return Array.isArray(snap.education) && snap.education.length > 0;
    case "skills":
      return Array.isArray(snap.skills) && snap.skills.length > 0;
    case "services":
      return Array.isArray(snap.services) && snap.services.length > 0;
    case "recent_posts":
      return Array.isArray(snap.recentPosts) && snap.recentPosts.length > 0;
    default:
      return false;
  }
}

export function createConversationStartersService(deps: ConversationStartersDeps): ConversationStartersService {
  async function loadEnrichmentRow(personId: string): Promise<PersonEnrichmentRow | null> {
    const row = await prisma.personEnrichment.findUnique({ where: { personId } });
    return row as PersonEnrichmentRow | null;
  }

  async function toContactSnapshot(personId: string, displayName: string): Promise<ContactProfileSnapshot | null> {
    const row = await loadEnrichmentRow(personId);
    if (!row) return null;
    return rowToContactSnapshot(row, displayName);
  }

  async function getOrGenerateSummary(personId: string, displayName: string): Promise<string | null> {
    const row = await loadEnrichmentRow(personId);
    if (!row) return null;
    const contact = rowToContactSnapshot(row, displayName);
    const self = await deps.selfProfile.loadAsContactSnapshot();
    const cacheKey = stableHash({ task: "summary", contact, self });
    if (row.summary && row.summaryCacheKey === cacheKey) {
      return row.summary;
    }
    const summary = await deps.aiService.generateContactSummary({ contact, self });
    if (!summary) return row.summary ?? null;
    await prisma.personEnrichment.update({
      where: { personId },
      data: { summary, summaryCacheKey: cacheKey }
    });
    return summary;
  }

  async function getOrGenerateStarters(
    personId: string,
    displayName: string
  ): Promise<ConversationStartersResult | null> {
    const row = await loadEnrichmentRow(personId);
    if (!row) return null;
    const contact = rowToContactSnapshot(row, displayName);
    const self = await deps.selfProfile.loadAsContactSnapshot();
    const cacheKey = stableHash({ task: "starters", contact, self });

    if (row.startersJson && row.startersCacheKey === cacheKey) {
      const cached = safeJsonParse<ConversationStartersResult | null>(row.startersJson, null);
      if (cached) return cached;
    }

    const generated = await deps.aiService.generateConversationStarters({ contact, self });
    if (!generated) return null;

    // Citation check — drop any starter whose cited field doesn't have
    // content in the actual enrichment payload. If at least 2 survive
    // we're done; otherwise log and persist what we have without
    // retrying (the operator can click Refresh to re-roll).
    const validated = generated.starters.filter((s) => {
      const ok = isFieldPopulated(s.citedField, contact);
      if (!ok) {
        console.warn(
          `[conversation-starters] dropping starter for person=${personId} citedField=${s.citedField} — field is empty in the enrichment payload`
        );
      }
      return ok;
    });

    const result: ConversationStartersResult = {
      starters: validated,
      generatedAt: new Date().toISOString(),
      validatedCount: validated.length
    };
    await prisma.personEnrichment.update({
      where: { personId },
      data: { startersJson: JSON.stringify(result), startersCacheKey: cacheKey }
    });
    return result;
  }

  return { getOrGenerateSummary, getOrGenerateStarters, toContactSnapshot };
}
