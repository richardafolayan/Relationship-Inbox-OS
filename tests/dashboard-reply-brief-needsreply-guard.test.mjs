import test from "node:test";
import assert from "node:assert/strict";

// Regression for Q14: the dashboard client-side fallback brief
// (chooseDisplayBrief) must mirror the server fallback and gate a real
// ask on needsReply. A dormant thread (needsReply=false) carrying a
// stale-but-real-looking whatTheyWant used to render that ask as a live
// "On you" obligation (a phantom Reply job), disagreeing with the
// server's "Nothing pending from them right now."
//
// Dashboard helpers ship as TypeScript; the runner is invoked with
// `node --import tsx --test ...` so the .ts import resolves at runtime.
const { chooseDisplayBrief } = await import("../apps/dashboard/lib/reply-brief.ts");

function thread(partial = {}) {
  return {
    replyBrief: null,
    summary: "",
    whatTheyWant: "",
    openLoops: [],
    needsReply: false,
    messages: [],
    ...partial
  };
}

test("chooseDisplayBrief: a real ask on a needsReply=false thread does NOT surface as a live job", () => {
  // Stale ask captured weeks ago; the thread no longer needs a reply.
  const result = chooseDisplayBrief(
    thread({
      summary: "Marianne — old project, wrapped up.",
      whatTheyWant: "She asked whether Friday at 11 still works.",
      openLoops: [],
      needsReply: false,
      messages: [{ direction: "IN", text: "Friday still good?" }]
    })
  );
  // Must fall through to the dormant phrasing, exactly like the server
  // fallback, instead of echoing the stale ask back as an obligation.
  assert.equal(result.on_you, "Nothing pending from them right now.");
  assert.equal(/Friday/.test(result.on_you), false);
});

test("chooseDisplayBrief: a real ask on a needsReply=true thread still surfaces (fix isn't over-broad)", () => {
  const result = chooseDisplayBrief(
    thread({
      summary: "Marianne — current project.",
      whatTheyWant: "She asked whether Friday at 11 still works.",
      openLoops: ["Confirm Friday at 11 works"],
      needsReply: true,
      messages: [{ direction: "IN", text: "Friday still good?" }]
    })
  );
  assert.equal(result.on_you, "She asked whether Friday at 11 still works.");
  assert.match(result.on_you, /Friday/);
});

test("chooseDisplayBrief: a static ask on a needsReply=false thread stays 'Nothing pending' (unchanged)", () => {
  const result = chooseDisplayBrief(
    thread({
      summary: "Brandon — old peer, last spoke six weeks ago.",
      whatTheyWant: "No clear ask yet.",
      needsReply: false,
      messages: [{ direction: "IN", text: "All good, talk soon." }]
    })
  );
  assert.equal(result.on_you, "Nothing pending from them right now.");
});
