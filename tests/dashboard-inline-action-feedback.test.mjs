import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  runActionWithInlineFeedback
} from "../apps/dashboard/lib/feedback.ts";
import {
  InlineActionButton
} from "../apps/dashboard/components/common/inline-action-button.tsx";
import {
  SiblingPlatformFilter
} from "../apps/dashboard/components/common/sibling-platform-filter.tsx";

test("shared inline action feedback preserves detailed failures", async () => {
  const states = [];
  const errors = [];
  const outcome = await runActionWithInlineFeedback(
    Promise.reject(new Error("Runner refused the stale Instagram session")),
    {
      pending: "Connecting Instagram...",
      success: "Instagram connected",
      failure: "Instagram needs attention",
      setState: (state) => states.push(state),
      setError: (message) => errors.push(message)
    }
  );

  assert.equal(outcome.ok, false);
  assert.deepEqual(states, [
    { phase: "running", label: "Connecting Instagram..." },
    { phase: "error", label: "Instagram needs attention" }
  ]);
  assert.deepEqual(errors, [null, "Runner refused the stale Instagram session"]);
});

test("shared inline action feedback reports success after the work resolves", async () => {
  const states = [];
  let refreshed = 0;
  const outcome = await runActionWithInlineFeedback(Promise.resolve({ connected: true }), {
    pending: "Connecting Instagram...",
    success: "Instagram connected",
    failure: "Instagram needs attention",
    setState: (state) => states.push(state),
    setError: () => undefined,
    onDone: async () => {
      refreshed += 1;
    }
  });

  assert.equal(outcome.ok, true);
  assert.equal(refreshed, 1);
  assert.deepEqual(states, [
    { phase: "running", label: "Connecting Instagram..." },
    { phase: "success", label: "Instagram connected" }
  ]);
});

test("inline action button renders running and successful states accessibly", () => {
  const running = renderToStaticMarkup(
    React.createElement(InlineActionButton, {
      idleLabel: "Connect Instagram",
      state: { phase: "running", label: "Connecting Instagram..." },
      onClick: () => undefined
    })
  );
  const success = renderToStaticMarkup(
    React.createElement(InlineActionButton, {
      idleLabel: "Scan now",
      state: { phase: "success", label: "Instagram connected" },
      onClick: () => undefined
    })
  );

  assert.match(running, /disabled=""/);
  assert.match(running, /aria-live="polite"/);
  assert.match(running, /Connecting Instagram/);
  assert.match(success, /data-phase="success"/);
  assert.match(success, />Scan now<\/button>/);
  assert.match(success, /role="status"/);
  assert.match(success, /Instagram connected/);
});

test("sibling platform filter renders Instagram when an Instagram thread exists", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SiblingPlatformFilter, {
      value: "all",
      siblings: [
        { platform: "LINKEDIN" },
        { platform: "INSTAGRAM" },
        { platform: "IMESSAGE" }
      ],
      onChange: () => undefined
    })
  );

  assert.match(markup, /aria-label="Filter sibling threads by platform"/);
  assert.match(markup, /value="INSTAGRAM">Instagram/);
});
