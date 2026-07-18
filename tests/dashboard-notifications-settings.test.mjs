import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const {
  classifyNotificationClient,
  messageNotificationsTitle,
  messageNotificationsDeviceLine,
  messageNotificationsDescription,
  messageNotificationsPermissionCaption,
  phoneNotificationsGroupHead,
  macNotificationsGroupHead,
  macNotificationsGroupSubhead,
  quietHoursDescription,
  digestDescription,
  digestFrequencyLabel,
  digestPreviewLabel,
  digestPreviewHint,
  digestBackgroundPingHint,
  DIGEST_CADENCE_OPTIONS
} = await import("../apps/dashboard/lib/notifications-settings.ts");

const {
  parseTimeToMinutes,
  formatMinutesAsTime,
  normaliseQuietTime,
  formatQuietHoursRange,
  isWithinQuietWindow,
  isQuietHoursEnabled,
  writeQuietHoursEnabled,
  readQuietHoursWindow,
  writeQuietHoursWindow,
  isQuietHoursActive,
  applyQuietHoursFromRunner,
  setQuietHoursHostState,
  getQuietHoursHostState,
  shouldSkipAutoScanForQuietHours,
  shouldMigrateLocalQuietHours,
  quietHoursPayloadForRunner,
  resetQuietHoursHostStateForTests,
  DEFAULT_QUIET_HOURS_WINDOW,
  QUIET_HOURS_KEY,
  QUIET_HOURS_WINDOW_KEY
} = await import("../apps/dashboard/lib/quiet-hours.ts");

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    }
  };
}

test("classifies phone and Mac clients for device labels", () => {
  assert.equal(
    classifyNotificationClient({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
    }),
    "phone"
  );
  assert.equal(
    classifyNotificationClient({
      userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36"
    }),
    "phone"
  );
  assert.equal(
    classifyNotificationClient({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      viewportWidth: 1280
    }),
    "mac"
  );
  assert.equal(
    classifyNotificationClient({
      userAgent: "Mozilla/5.0",
      maxTouchPoints: 5,
      pointerCoarse: true,
      viewportWidth: 390
    }),
    "phone"
  );
});

test("message notification copy names the device, not the browser, on phone", () => {
  assert.equal(messageNotificationsTitle("phone"), "Message notifications");
  assert.equal(messageNotificationsDeviceLine("phone"), "On this phone");
  assert.equal(messageNotificationsDeviceLine("mac"), "On this Mac");
  // Phone copy must not overpromise iOS background / killed-app push.
  assert.match(messageNotificationsDescription("phone"), /while this app is open/i);
  assert.match(messageNotificationsDescription("phone"), /fully closed/i);
  assert.doesNotMatch(messageNotificationsDescription("phone"), /in the background/i);
  assert.doesNotMatch(messageNotificationsDescription("phone"), /desktop/i);
  assert.doesNotMatch(messageNotificationsDescription("phone"), /browser/i);
  // Browser path is also foreground/tab-open only (no SW push stack yet).
  assert.match(messageNotificationsDescription("browser"), /while this tab is open/i);
  assert.doesNotMatch(messageNotificationsDescription("browser"), /in the background/i);

  assert.equal(
    messageNotificationsPermissionCaption("granted", "phone"),
    "On · turn off in phone settings"
  );
  assert.equal(
    messageNotificationsPermissionCaption("denied", "phone"),
    "Blocked · re-enable in phone settings"
  );
  assert.equal(
    messageNotificationsPermissionCaption("granted", "mac"),
    "On · turn off in System Settings"
  );
  assert.equal(messageNotificationsPermissionCaption("default", "mac"), "Off");
  assert.doesNotMatch(
    messageNotificationsPermissionCaption("granted", "phone"),
    /browser/i
  );
});

test("notification copy claims match foreground-only Notification API behaviour", () => {
  // No service worker / PushManager path exists; copy must not promise
  // delivery when the phone app is backgrounded or killed.
  for (const client of ["phone", "mac", "browser"]) {
    const desc = messageNotificationsDescription(client);
    const hint = digestBackgroundPingHint(client);
    assert.doesNotMatch(desc, /push notification/i);
    assert.doesNotMatch(hint, /push notification/i);
    assert.doesNotMatch(desc, /even when (the app|it) is closed/i);
    assert.doesNotMatch(desc, /locked screen/i);
  }
  assert.match(messageNotificationsDescription("phone"), /may not arrive if the app is fully closed/i);
  assert.match(digestBackgroundPingHint("phone"), /while the app is open/i);
  assert.doesNotMatch(digestBackgroundPingHint("phone"), /in the background/i);
  assert.doesNotMatch(digestBackgroundPingHint("browser"), /in the background/i);

  // Settings page must not invent a web-push stack.
  const page = read("apps/dashboard/app/settings/page.tsx");
  assert.doesNotMatch(page, /serviceWorker|PushManager|web-push|web push/i);
  const helpers = read("apps/dashboard/lib/notifications-settings.ts");
  assert.doesNotMatch(helpers, /\bPushManager\b|\bserviceWorker\b|\bweb-push\b/i);
});

test("settings groups separate phone notifications from Mac scanning", () => {
  assert.equal(phoneNotificationsGroupHead("phone"), "Phone notifications");
  assert.equal(phoneNotificationsGroupHead("mac"), "This device");
  assert.equal(macNotificationsGroupHead(), "Mac notifications and scanning");
  assert.match(macNotificationsGroupSubhead(), /Mac where the app is open/i);
  assert.match(quietHoursDescription(), /Mac scanning/i);
});

test("digest frequency options and non-interactive preview copy", () => {
  assert.deepEqual(
    DIGEST_CADENCE_OPTIONS.map((o) => o.id),
    ["off", "daily", "weekly"]
  );
  assert.equal(digestFrequencyLabel(), "How often");
  assert.match(digestDescription(), /notification bell/i);
  assert.equal(digestPreviewLabel(), "Who would be included");
  assert.match(digestPreviewHint(), /Preview only/i);
  assert.match(digestBackgroundPingHint("phone"), /message notifications/i);
  assert.doesNotMatch(digestBackgroundPingHint("phone"), /desktop notifications/i);
  assert.doesNotMatch(digestBackgroundPingHint("phone"), /in the background/i);
});

test("quiet hours window parse, format, and overnight membership", () => {
  assert.equal(parseTimeToMinutes("22:00"), 22 * 60);
  assert.equal(parseTimeToMinutes("6:30"), 6 * 60 + 30);
  assert.equal(parseTimeToMinutes("25:00"), null);
  assert.equal(formatMinutesAsTime(22 * 60 + 5), "22:05");
  assert.equal(normaliseQuietTime("9:05"), "09:05");
  assert.equal(formatQuietHoursRange(DEFAULT_QUIET_HOURS_WINDOW), "22:00 to 06:00");

  const overnight = { start: "22:00", end: "06:00" };
  assert.equal(isWithinQuietWindow(new Date(2026, 0, 1, 22, 0), overnight), true);
  assert.equal(isWithinQuietWindow(new Date(2026, 0, 1, 23, 30), overnight), true);
  assert.equal(isWithinQuietWindow(new Date(2026, 0, 1, 5, 59), overnight), true);
  assert.equal(isWithinQuietWindow(new Date(2026, 0, 1, 6, 0), overnight), false);
  assert.equal(isWithinQuietWindow(new Date(2026, 0, 1, 12, 0), overnight), false);

  const daytime = { start: "13:00", end: "17:00" };
  assert.equal(isWithinQuietWindow(new Date(2026, 0, 1, 13, 0), daytime), true);
  assert.equal(isWithinQuietWindow(new Date(2026, 0, 1, 16, 59), daytime), true);
  assert.equal(isWithinQuietWindow(new Date(2026, 0, 1, 17, 0), daytime), false);
  assert.equal(isWithinQuietWindow(new Date(2026, 0, 1, 22, 0), daytime), false);
});

test("quiet hours enable flag and custom window round-trip through storage", () => {
  resetQuietHoursHostStateForTests();
  const storage = memoryStorage();
  assert.equal(isQuietHoursEnabled(storage), false);
  writeQuietHoursEnabled(true, storage);
  assert.equal(storage.getItem(QUIET_HOURS_KEY), "1");
  assert.equal(isQuietHoursEnabled(storage), true);

  assert.deepEqual(readQuietHoursWindow(storage), DEFAULT_QUIET_HOURS_WINDOW);
  const saved = writeQuietHoursWindow({ start: "21:30", end: "07:15" }, storage);
  assert.deepEqual(saved, { start: "21:30", end: "07:15" });
  assert.deepEqual(readQuietHoursWindow(storage), { start: "21:30", end: "07:15" });
  assert.ok(storage.getItem(QUIET_HOURS_WINDOW_KEY));

  // Active only when toggle is on and local time is inside the window.
  assert.equal(
    isQuietHoursActive(new Date(2026, 0, 1, 22, 0), storage),
    true
  );
  writeQuietHoursEnabled(false, storage);
  assert.equal(
    isQuietHoursActive(new Date(2026, 0, 1, 22, 0), storage),
    false
  );
});

test("phone quiet hours change reaches Mac scan path via runner-shared host state", () => {
  // Phone and Mac use different browser origins (Tailscale vs localhost).
  // localStorage is NOT shared; runner AppSettings is.
  resetQuietHoursHostStateForTests();
  const phoneLocal = memoryStorage();
  const macLocal = memoryStorage();

  // Phone Settings writes through the runner payload shape.
  const phoneWrite = setQuietHoursHostState(
    { enabled: true, window: { start: "21:00", end: "07:00" } },
    phoneLocal
  );
  assert.deepEqual(quietHoursPayloadForRunner(phoneWrite), {
    quietHoursEnabled: true,
    quietHoursWindow: { start: "21:00", end: "07:00" }
  });

  // Mac AppShell applies the runner response; its own localStorage stays empty.
  resetQuietHoursHostStateForTests();
  assert.equal(isQuietHoursEnabled(macLocal), false);
  const macHost = applyQuietHoursFromRunner(
    {
      quietHoursEnabled: true,
      quietHoursWindow: { start: "21:00", end: "07:00" }
    },
    macLocal
  );
  assert.equal(macHost.source, "runner");
  assert.equal(macHost.enabled, true);
  assert.deepEqual(macHost.window, { start: "21:00", end: "07:00" });

  const inside = new Date(2026, 0, 1, 22, 30);
  const outside = new Date(2026, 0, 1, 12, 0);
  assert.equal(shouldSkipAutoScanForQuietHours(inside, macHost), true);
  assert.equal(shouldSkipAutoScanForQuietHours(outside, macHost), false);
  assert.equal(isQuietHoursActive(inside), true);
  // Mac origin localStorage never received the phone write.
  assert.equal(isQuietHoursEnabled(macLocal), false);
  assert.equal(isQuietHoursActive(inside, macLocal), false);
});

test("runner-missing quiet hours dual-reads localStorage and migrates", () => {
  resetQuietHoursHostStateForTests();
  const storage = memoryStorage({
    [QUIET_HOURS_KEY]: "1",
    [QUIET_HOURS_WINDOW_KEY]: JSON.stringify({ start: "23:00", end: "05:00" })
  });
  assert.equal(shouldMigrateLocalQuietHours({}, storage), true);
  assert.equal(
    shouldMigrateLocalQuietHours({ quietHoursEnabled: false }, storage),
    false
  );
  const applied = applyQuietHoursFromRunner({}, storage);
  assert.equal(applied.source, "local");
  assert.equal(applied.enabled, true);
  assert.deepEqual(applied.window, { start: "23:00", end: "05:00" });
  assert.equal(getQuietHoursHostState(storage).enabled, true);
});

test("settings page wires phone vs Mac sections, switches, and digest controls", () => {
  const page = read("apps/dashboard/app/settings/page.tsx");
  const shell = read("apps/dashboard/components/layout/app-shell.tsx");

  assert.match(page, /data-testid="notifications-settings"/);
  assert.match(page, /phoneNotificationsGroupHead/);
  assert.match(page, /macNotificationsGroupHead/);
  assert.match(page, /messageNotificationsDeviceLine/);
  assert.match(page, /testId="quiet-hours-row"/);
  assert.match(page, /data-testid="quiet-hours-time-editors"/);
  assert.match(page, /type="time"/);
  assert.match(page, /data-testid="message-notifications-row"/);
  assert.match(page, /data-testid="digest-cadence-group"/);
  assert.match(page, /data-testid="digest-preview"/);
  assert.match(page, /DIGEST_CADENCE_OPTIONS/);
  assert.match(page, /digestPreviewHint/);

  // Quiet hours persist on the runner host, not browser-origin localStorage alone.
  assert.match(page, /applyQuietHoursFromRunner/);
  assert.match(page, /quietHoursPayloadForRunner/);
  assert.match(page, /\/runner\/control\/settings/);
  assert.match(page, /quietHoursEnabled/);
  assert.match(shell, /applyQuietHoursFromRunner/);
  assert.match(shell, /shouldSkipAutoScanForQuietHours/);
  assert.match(shell, /\/runner\/data\/settings/);

  // Mobile switch rows: title-aligned toggle, 44px touch target.
  assert.match(page, /min-h-\[44px\]/);
  assert.match(page, /MobileSwitchRow/);

  // No desktop/browser-only captions or repeated snooze links in Settings.
  assert.doesNotMatch(page, /Desktop notifications/);
  assert.doesNotMatch(page, /turn off in your browser/);
  assert.doesNotMatch(page, /Snooze 7 days/);
  assert.doesNotMatch(page, /snoozePerson/);
  assert.doesNotMatch(page, /unsnoozePerson/);
  assert.doesNotMatch(page, /Enable desktop notifications/);
});

test("user-facing notification settings copy has no em or en dashes", () => {
  const helpers = read("apps/dashboard/lib/notifications-settings.ts");
  const page = read("apps/dashboard/app/settings/page.tsx");
  const banned = /[—–]/;
  for (const sample of [
    messageNotificationsPermissionCaption("granted", "phone"),
    messageNotificationsPermissionCaption("denied", "mac"),
    messageNotificationsDescription("phone"),
    quietHoursDescription(),
    digestDescription(),
    digestPreviewHint(),
    digestBackgroundPingHint("phone"),
    macNotificationsGroupSubhead(),
    formatQuietHoursRange()
  ]) {
    assert.ok(!banned.test(sample), `banned dash in ${JSON.stringify(sample)}`);
  }
  // Helper source strings used as UI copy should stay dash-clean too.
  assert.doesNotMatch(helpers, /—|–/);
  // The notifications panel itself should not introduce UI em/en dashes.
  const panelSlice = page.slice(
    page.indexOf("function NotificationsSettingsPanel"),
    page.indexOf("function SegmentedControl")
  );
  assert.doesNotMatch(panelSlice, /—|–/);
});
