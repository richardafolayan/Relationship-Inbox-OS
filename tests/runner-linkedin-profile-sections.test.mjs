import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "patchright";
import { extractProfileSections } from "../apps/runner/dist/platforms/linkedin-profile-adapter.js";

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "linkedin");

// Load a profile fixture into a real headless Chromium page and run the
// structural section parser against it. Chromium is required because the
// parser leans on `.innerText` and layout-aware behaviour that jsdom does
// not implement; if the browser can't launch we skip rather than fail.
async function loadSections(fixtureName) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    return { skipped: true, reason: `Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const html = await readFile(join(FIXTURE_DIR, fixtureName), "utf8");
    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, {
      waitUntil: "domcontentloaded"
    });
    const sections = await extractProfileSections(page);
    return { sections };
  } finally {
    await browser.close();
  }
}

test("parses experience entries with title, company, dates, and description", async (t) => {
  const r = await loadSections("profile-with-sections.html");
  if (r.skipped) return t.skip(r.reason);
  const s = r.sections;
  assert.ok(s, "sections should not be null");

  assert.equal(s.experience.length, 2, "two top-level experience entries");

  assert.equal(s.experience[0].title, "Senior Software Engineer");
  assert.equal(s.experience[0].company, "Acme Corporation", "company strips the ' · Full-time' suffix");
  assert.match(s.experience[0].dates, /Jan 2020 - Present/);
  assert.match(s.experience[0].description, /Leading the platform team/);

  assert.equal(s.experience[1].title, "Software Engineer");
  assert.equal(s.experience[1].company, "Globex");
  assert.match(s.experience[1].dates, /2016 - 2019/);
  assert.equal(s.experience[1].description, null, "short entry has no long-form description");
});

test("parses education with degree / field split and dates", async (t) => {
  const r = await loadSections("profile-with-sections.html");
  if (r.skipped) return t.skip(r.reason);
  const s = r.sections;
  assert.ok(s);

  assert.equal(s.education.length, 1);
  assert.equal(s.education[0].institution, "University of Example");
  assert.equal(s.education[0].degree, "Bachelor of Science");
  assert.equal(s.education[0].field, "Computer Science");
  assert.match(s.education[0].dates, /2012 - 2016/);
});

test("parses skills from list rows and services from a chip-line fallback", async (t) => {
  const r = await loadSections("profile-with-sections.html");
  if (r.skipped) return t.skip(r.reason);
  const s = r.sections;
  assert.ok(s);

  // Skill name is the first line of each row; the endorsement line is ignored.
  assert.deepEqual(s.skills, ["JavaScript", "TypeScript", "Distributed Systems"]);

  // Services has no <li> rows, so nameList splits the section body on separators.
  assert.deepEqual(s.services, ["Web Development", "Cloud Consulting", "Technical Writing"]);
});

test("parses licenses with name, issuer, and dates", async (t) => {
  const r = await loadSections("profile-with-sections.html");
  if (r.skipped) return t.skip(r.reason);
  const s = r.sections;
  assert.ok(s);

  assert.equal(s.licenses.length, 1);
  assert.equal(s.licenses[0].name, "AWS Certified Solutions Architect");
  assert.equal(s.licenses[0].issuer, "Amazon Web Services");
  assert.match(s.licenses[0].dates, /Mar 2021/);
});

test("reports presence true with an empty array when a section heading has no parseable entries", async (t) => {
  const r = await loadSections("profile-empty-section.html");
  if (r.skipped) return t.skip(r.reason);
  const s = r.sections;
  assert.ok(s);

  // Fail-loud, not fabricate: heading detected, zero entries extracted.
  assert.equal(s.presence.experience, true, "experience heading is present");
  assert.equal(s.experience.length, 0, "no entries fabricated");
  assert.equal(s.presence.education, false);
  assert.equal(s.presence.skills, false);
});

test("returns empty arrays and all-false presence when no structured sections exist", async (t) => {
  const r = await loadSections("profile-no-sections.html");
  if (r.skipped) return t.skip(r.reason);
  const s = r.sections;
  assert.ok(s);

  assert.deepEqual(s.experience, []);
  assert.deepEqual(s.education, []);
  assert.deepEqual(s.skills, []);
  assert.deepEqual(s.services, []);
  assert.deepEqual(s.licenses, []);
  assert.deepEqual(s.presence, {
    experience: false,
    education: false,
    skills: false,
    services: false,
    licenses: false
  });
});

test("collapses grouped sub-roles into a single top-level experience entry", async (t) => {
  const r = await loadSections("profile-grouped-roles.html");
  if (r.skipped) return t.skip(r.reason);
  const s = r.sections;
  assert.ok(s);

  // One company row with two nested role <li>s must yield exactly one entry,
  // not three — nested rows are excluded, never double-counted.
  assert.equal(s.experience.length, 1);
  assert.equal(s.experience[0].title, "Acme Corporation");
});

test("parses sanitized real DOM fallback sections without aria-hidden row text", async (t) => {
  const r = await loadSections("profile-real-dom-derived-fallback.html");
  if (r.skipped) return t.skip(r.reason);
  const s = r.sections;
  assert.ok(s);

  assert.equal(s.presence.experience, true);
  assert.equal(s.experience.length, 2);
  assert.equal(s.experience[0].title, "Founder");
  assert.match(s.experience[0].dates, /Jan 2024 - Present/);
  assert.match(s.experience[1].description, /launch checklist/);

  assert.equal(s.presence.education, true);
  assert.equal(s.education.length, 2);
  assert.equal(s.education[0].institution, "Example University");
  assert.equal(s.education[0].degree, "Bachelor of Science");
  assert.equal(s.education[0].field, "Computer Science");
  assert.match(s.education[0].dates, /2021 - 2025/);

  assert.equal(s.presence.licenses, true);
  assert.equal(s.licenses.length, 1);
  assert.equal(s.licenses[0].name, "Privacy Certificate");
  assert.equal(s.licenses[0].issuer, "Example Institute");
  assert.match(s.licenses[0].dates, /Jan 2024/);
});
