import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  activateLinkedInUnreadFilter,
  shouldClickLinkedInUnreadPill,
  waitForLinkedInUnreadRefresh
} from "../apps/runner/dist/platforms/linkedin-adapter.js";

class FakeLocator {
  constructor(state, type) {
    this.state = state;
    this.type = type;
  }

  first() {
    return this;
  }

  async count() {
    if (this.type === "pill") {
      return this.state.pillPresent ? 1 : 0;
    }
    if (this.type === "spinner") {
      const next = this.state.spinnerCounts.shift();
      return typeof next === "number" ? next : 0;
    }
    return 0;
  }

  async getAttribute(name) {
    if (this.type !== "pill" || !this.state.pillPresent) {
      return null;
    }
    if (name === "aria-pressed") {
      return this.state.active ? "true" : "false";
    }
    if (name === "aria-checked") {
      return this.state.checked ? "true" : "false";
    }
    return null;
  }

  async click() {
    this.state.clicks += 1;
    if (this.state.activateOnClick) {
      this.state.active = true;
    }
  }
}

class FakePage {
  constructor(state) {
    this.state = state;
  }

  locator(selector) {
    if (selector.includes("data-test-messaging-inbox-filters__filter-pill")) {
      return new FakeLocator(this.state, "pill");
    }
    if (selector.includes("artdeco-loader") || selector.includes("aria-label*='Loading'")) {
      return new FakeLocator(this.state, "spinner");
    }
    return new FakeLocator(this.state, "other");
  }

  async waitForTimeout(ms) {
    this.state.waitCalls.push(ms);
  }
}

test("LinkedIn unread fixture indicates pill should be clicked when inactive", async () => {
  const fixturePath = join(process.cwd(), "tests", "fixtures", "linkedin", "unread-pill.html");
  const html = await readFile(fixturePath, "utf8");
  const match = html.match(/aria-pressed="([^"]+)"/i);

  const shouldClick = shouldClickLinkedInUnreadPill({
    present: html.includes("data-test-messaging-inbox-filters__filter-pill=\"UNREAD\""),
    ariaPressed: match?.[1] ?? null,
    ariaChecked: null
  });

  assert.equal(shouldClick, true);
});

test("activateLinkedInUnreadFilter clicks pill when inactive and stops on active-state flip", async () => {
  const state = {
    pillPresent: true,
    active: false,
    checked: false,
    activateOnClick: true,
    clicks: 0,
    spinnerCounts: [0, 0, 0],
    waitCalls: []
  };

  const result = await activateLinkedInUnreadFilter(new FakePage(state));
  assert.equal(state.clicks, 1);
  assert.equal(result.clicked, true);
  assert.equal(result.waitReason, "state_flip");
});

test("activateLinkedInUnreadFilter does not click when unread pill is already active", async () => {
  const state = {
    pillPresent: true,
    active: true,
    checked: false,
    activateOnClick: true,
    clicks: 0,
    spinnerCounts: [],
    waitCalls: []
  };

  const result = await activateLinkedInUnreadFilter(new FakePage(state));
  assert.equal(result.clicked, false);
  assert.equal(result.waitReason, "already_active");
  assert.equal(state.clicks, 0);
});

test("activateLinkedInUnreadFilter continues safely when unread pill is missing", async () => {
  const state = {
    pillPresent: false,
    active: false,
    checked: false,
    activateOnClick: false,
    clicks: 0,
    spinnerCounts: [],
    waitCalls: []
  };

  const result = await activateLinkedInUnreadFilter(new FakePage(state));
  assert.equal(result.pillPresent, false);
  assert.equal(result.waitReason, "pill_missing");
  assert.equal(state.clicks, 0);
});

test("waitForLinkedInUnreadRefresh uses bounded settle-delay fallback when no refresh signal appears", async () => {
  const waitCalls = [];

  const reason = await waitForLinkedInUnreadRefresh({
    waitForStateFlip: async () => false,
    waitForSpinnerCycle: async () => false,
    waitForTimeout: async (ms) => {
      waitCalls.push(ms);
    },
    settleDelayMs: 400
  });

  assert.equal(reason, "settle_delay");
  assert.deepEqual(waitCalls, [400]);
});
