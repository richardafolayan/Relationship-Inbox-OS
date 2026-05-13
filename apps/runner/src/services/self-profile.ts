import type { PlatformName } from "@inbox-os/core";
import { prisma } from "../db";
import type { SessionManager } from "./session-manager";
import { extractProfile, type ExtractedProfile } from "../platforms/linkedin-profile-adapter";
import type { ContactProfileSnapshot } from "../types/runtime";

export const SELF_PROFILE_SETTING_KEY = "self.linkedinProfile";

/**
 * Persisted shape of the operator's own profile. Mirrors
 * ExtractedProfile + the URL it was scraped from + a timestamp for
 * staleness checks. Stored in the Setting table as JSON under the key
 * SELF_PROFILE_SETTING_KEY — single-row by design (single-user app).
 */
export interface SelfProfileRecord extends ExtractedProfile {
  profileUrl: string;
  fetchedAt: string;
}

export interface SelfProfileService {
  /** Read the persisted self-profile, or null if it has never been set. */
  load(): Promise<SelfProfileRecord | null>;
  /** Same as `load` but projected to the AI prompt input shape. */
  loadAsContactSnapshot(displayName?: string): Promise<ContactProfileSnapshot | null>;
  /**
   * Visit the operator's LinkedIn profile and persist a fresh extraction.
   * Throws on failure so the caller can surface the reason to the
   * dashboard.
   */
  refresh(input: { profileUrl: string }): Promise<SelfProfileRecord>;
}

interface SelfProfileServiceDeps {
  sessionManager: SessionManager;
  /** Person key to scope the browser context — defaults to "default". */
  personKey?: string;
}

export function createSelfProfileService(deps: SelfProfileServiceDeps): SelfProfileService {
  const personKey = deps.personKey ?? "default";

  async function load(): Promise<SelfProfileRecord | null> {
    const row = await prisma.setting.findUnique({ where: { key: SELF_PROFILE_SETTING_KEY } });
    if (!row) return null;
    try {
      return JSON.parse(row.valueJson) as SelfProfileRecord;
    } catch {
      // Corrupt JSON — treat as missing. The next refresh will overwrite.
      return null;
    }
  }

  async function loadAsContactSnapshot(displayName?: string): Promise<ContactProfileSnapshot | null> {
    const record = await load();
    if (!record) return null;
    return {
      displayName,
      headline: record.headline,
      about: record.about,
      location: record.location,
      currentCompany: record.currentCompany,
      currentRole: record.currentRole,
      experience: record.experience,
      education: record.education,
      skills: record.skills,
      services: record.services,
      recentPosts: record.recentPosts
    };
  }

  async function refresh(input: { profileUrl: string }): Promise<SelfProfileRecord> {
    const platform: PlatformName = "LINKEDIN";
    const page = await deps.sessionManager.getManagedPage({ platform, personKey });
    const result = await extractProfile(page, input.profileUrl);
    if ("failed" in result && result.failed) {
      throw new Error(`self profile extraction failed: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
    }

    const record: SelfProfileRecord = {
      ...(result as ExtractedProfile),
      profileUrl: input.profileUrl,
      fetchedAt: new Date().toISOString()
    };
    await prisma.setting.upsert({
      where: { key: SELF_PROFILE_SETTING_KEY },
      update: { valueJson: JSON.stringify(record) },
      create: { key: SELF_PROFILE_SETTING_KEY, valueJson: JSON.stringify(record) }
    });
    return record;
  }

  return { load, loadAsContactSnapshot, refresh };
}
