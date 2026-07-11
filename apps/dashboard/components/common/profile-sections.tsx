"use client";

import { useState } from "react";
import { apiPost } from "@/lib/api";
import type { PersonDetailResponse } from "@/lib/types";
import { formatRelative } from "@/lib/time";

interface ProfileSectionsProps {
  detail: PersonDetailResponse;
  /**
   * When true, skip the big name heading. The People-page inline
   * accordion already shows the person's name on the row directly above
   * the panel - repeating it inside the panel is redundant. Defaults to
   * false so the thread-page profile drawer (called from a different
   * context) keeps showing the name as before.
   */
  hideName?: boolean;
}

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">{children}</p>
  );
}

export function ProfileSections({ detail, hideName = false }: ProfileSectionsProps) {
  const { person, enrichment } = detail;
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  // Routes the click through the runner so the profile lands in the
  // runner-controlled Chrome (which is signed into LinkedIn) rather
  // than the operator's default browser. Falls back gracefully when
  // the runner can't reach Chrome - in that case we still open in
  // the default browser so the operator isn't blocked.
  const openProfileInRunner = async () => {
    if (!person.profileUrl) return;
    setOpening(true);
    setOpenError(null);
    try {
      await apiPost(`/runner/control/person/${person.id}/open-profile`, {});
    } catch (err) {
      const message = err instanceof Error ? err.message : "open failed";
      setOpenError(message);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="space-y-7">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
          {person.platform}
          {person.profileUrlSource ? <> · profile {person.profileUrlSource}-discovered</> : null}
          {person.enrichedAt ? <> · enriched {formatRelative(person.enrichedAt)}</> : null}
        </p>
        {hideName ? null : (
          <h3 className="mt-2 font-display text-[24px] font-semibold tracking-[-0.02em]">
            {person.name}
          </h3>
        )}
        {enrichment?.headline ? (
          <p className={`${hideName ? "mt-2" : "mt-1"} max-w-[58ch] text-[14px] leading-[1.55] text-ink-2`}>{enrichment.headline}</p>
        ) : null}
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[12px] text-ink-3">
          {enrichment?.currentRole || enrichment?.currentCompany ? (
            <li>{[enrichment?.currentRole, enrichment?.currentCompany].filter(Boolean).join(" at ")}</li>
          ) : null}
          {enrichment?.location ? <li>{enrichment.location}</li> : null}
          {typeof enrichment?.followersCount === "number" ? (
            <li>{compactNumber(enrichment.followersCount)} followers</li>
          ) : null}
          {typeof enrichment?.mutualCount === "number" ? (
            <li>{enrichment.mutualCount} mutual</li>
          ) : null}
          {person.profileUrl ? (
            <li>
              <button
                type="button"
                onClick={openProfileInRunner}
                disabled={opening}
                className="underline-offset-2 hover:text-ink hover:underline disabled:opacity-60"
                title="Open in the runner's Chrome (already signed in to LinkedIn)"
              >
                {opening ? "opening…" : "open profile ↗"}
              </button>
              {openError ? (
                <span className="ml-2 text-[11px] text-ink-2">{openError}</span>
              ) : null}
            </li>
          ) : null}
        </ul>
      </div>

      {enrichment?.about ? (
        <section>
          <SectionHead>About</SectionHead>
          <p className="m-0 max-w-[64ch] whitespace-pre-line text-[13.5px] leading-[1.55] text-ink-2">
            {enrichment.about}
          </p>
        </section>
      ) : null}

      {enrichment && enrichment.experience.length > 0 ? (
        <section>
          <SectionHead>Experience</SectionHead>
          <ul className="m-0 list-none space-y-2 p-0">
            {enrichment.experience.map((item, idx) => (
              <li key={idx} className="text-[13.5px] leading-[1.5] text-ink">
                <span className="font-medium">{item.title ?? "-"}</span>
                {item.company ? <span className="text-ink-2"> · {item.company}</span> : null}
                {item.dates ? (
                  <span className="ml-2 font-mono text-[11px] text-ink-3">{item.dates}</span>
                ) : null}
                {item.description ? (
                  <p className="mt-1 max-w-[64ch] text-[12.5px] leading-[1.5] text-ink-2">
                    {item.description}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {enrichment && enrichment.education.length > 0 ? (
        <section>
          <SectionHead>Education</SectionHead>
          <ul className="m-0 list-none space-y-1 p-0">
            {enrichment.education.map((item, idx) => (
              <li key={idx} className="text-[13.5px] leading-[1.5] text-ink">
                <span className="font-medium">{item.institution ?? "-"}</span>
                {item.degree ? <span className="text-ink-2"> · {item.degree}</span> : null}
                {item.field ? <span className="text-ink-2">, {item.field}</span> : null}
                {item.dates ? (
                  <span className="ml-2 font-mono text-[11px] text-ink-3">{item.dates}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {enrichment && enrichment.licenses.length > 0 ? (
        <section>
          <SectionHead>Licenses & certifications</SectionHead>
          <ul className="m-0 list-none space-y-1 p-0">
            {enrichment.licenses.map((item, idx) => (
              <li key={idx} className="text-[13.5px] leading-[1.5] text-ink">
                <span className="font-medium">{item.name ?? "-"}</span>
                {item.issuer ? <span className="text-ink-2"> · {item.issuer}</span> : null}
                {item.dates ? (
                  <span className="ml-2 font-mono text-[11px] text-ink-3">{item.dates}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {enrichment && enrichment.skills.length > 0 ? (
        <section>
          <SectionHead>Skills</SectionHead>
          <div className="flex flex-wrap gap-2">
            {enrichment.skills.map((skill, idx) => (
              <span
                key={idx}
                className="rounded-full border border-hairline bg-paper px-2 py-[2px] font-mono text-[11px] text-ink-2"
              >
                {skill}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {enrichment && enrichment.services.length > 0 ? (
        <section>
          <SectionHead>Services</SectionHead>
          <ul className="m-0 list-none space-y-1 p-0 text-[13px] text-ink-2">
            {enrichment.services.map((s, idx) => (
              <li key={idx}>{s}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {enrichment && enrichment.mutualNames.length > 0 ? (
        <section>
          <SectionHead>Mutual connections</SectionHead>
          <p className="m-0 max-w-[58ch] text-[13px] text-ink-2">{enrichment.mutualNames.join(", ")}</p>
        </section>
      ) : null}

      {enrichment && enrichment.recentPosts.length > 0 ? (
        <section>
          <SectionHead>Recent posts</SectionHead>
          <ul className="m-0 list-none space-y-3 p-0">
            {enrichment.recentPosts.map((post, idx) => (
              <li key={idx} className="rounded-row border border-hairline p-3 text-[13px] leading-[1.55] text-ink-2">
                {post.text ? <p className="m-0 whitespace-pre-line">{post.text}</p> : null}
                <p className="mt-2 font-mono text-[11px] text-ink-3">
                  {post.postedAt ?? "-"}
                  {post.hasImage ? " · 📷" : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {enrichment && enrichment.recentComments.length > 0 ? (
        <section>
          <SectionHead>Recent comments</SectionHead>
          <ul className="m-0 list-none space-y-3 p-0">
            {enrichment.recentComments.map((c, idx) => (
              <li key={idx} className="rounded-row border border-hairline p-3 text-[13px] leading-[1.55] text-ink-2">
                {c.text ? <p className="m-0 whitespace-pre-line">{c.text}</p> : null}
                <p className="mt-2 font-mono text-[11px] text-ink-3">
                  {c.onPostBy ? `on ${c.onPostBy} · ` : ""}
                  {c.postedAt ?? "-"}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {enrichment && enrichment.recentReactions.length > 0 ? (
        <section>
          <SectionHead>Recent reactions</SectionHead>
          <ul className="m-0 list-none space-y-3 p-0">
            {enrichment.recentReactions.map((r, idx) => (
              <li key={idx} className="rounded-row border border-hairline p-3 text-[13px] leading-[1.55] text-ink-2">
                <p className="m-0 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
                  {r.reaction ?? "reacted"} {r.onPostBy ? `· ${r.onPostBy}` : ""}
                </p>
                {r.text ? <p className="mt-1 whitespace-pre-line">{r.text}</p> : null}
                <p className="mt-2 font-mono text-[11px] text-ink-3">{r.postedAt ?? "-"}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!enrichment && person.platform === "LINKEDIN" ? (
        <p className="text-[13px] text-ink-3">
          {person.profileUrl
            ? "Not enriched yet. Use rescan to fetch the LinkedIn profile."
            : "We don't have a LinkedIn profile URL for this person yet."}
        </p>
      ) : null}
    </div>
  );
}
