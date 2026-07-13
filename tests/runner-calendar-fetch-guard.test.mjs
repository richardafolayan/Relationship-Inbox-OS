import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  normalizeCalendarUrl,
  fetchIcsText,
  CalendarFetchError
} from "../apps/runner/dist/services/calendar-fetch.js";

// URL normalisation + SSRF guard for the operator's iCal feed (#786). The
// guard itself is shared with link-preview (its own tests cover the address
// ranges); here we pin the calendar-specific behaviour: webcal handling, and
// that a private target is refused unless the test escape hatch is set.

test("normalizeCalendarUrl maps webcal:// to https:// and fills a bare host", () => {
  assert.equal(
    normalizeCalendarUrl("webcal://cal.example.com/f.ics")?.toString(),
    "https://cal.example.com/f.ics"
  );
  assert.equal(
    normalizeCalendarUrl("cal.example.com/f.ics")?.toString(),
    "https://cal.example.com/f.ics"
  );
  assert.equal(
    normalizeCalendarUrl("http://cal.example.com/f.ics")?.toString(),
    "http://cal.example.com/f.ics"
  );
});

test("normalizeCalendarUrl rejects non-http(s) schemes and empty input", () => {
  assert.equal(normalizeCalendarUrl("ftp://cal.example.com/f.ics"), null);
  assert.equal(normalizeCalendarUrl("file:///etc/passwd"), null);
  assert.equal(normalizeCalendarUrl("   "), null);
});

test("fetchIcsText refuses a loopback target by default (SSRF guard)", async () => {
  await assert.rejects(
    () => fetchIcsText("http://127.0.0.1:9/does-not-matter.ics"),
    (err) => err instanceof CalendarFetchError
  );
});

test("fetchIcsText reads a feed when the private-target escape hatch is set", async () => {
  const body = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR";
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/calendar" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const result = await fetchIcsText(`http://127.0.0.1:${port}/cal.ics`, {
      allowPrivateTargets: true
    });
    assert.equal(result.text, body);
  } finally {
    server.close();
  }
});

test("fetchIcsText surfaces a non-2xx status as a CalendarFetchError", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end("nope");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await assert.rejects(
      () => fetchIcsText(`http://127.0.0.1:${port}/missing.ics`, { allowPrivateTargets: true }),
      (err) => err instanceof CalendarFetchError && /404/.test(err.message)
    );
  } finally {
    server.close();
  }
});
