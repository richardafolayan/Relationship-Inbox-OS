import test from "node:test";
import assert from "node:assert/strict";

const { isLikelyClosed } = await import(
  "../apps/dashboard/lib/closed-conversation.ts"
);

const IN = "IN";
const OUT = "OUT";

const closed = (preview, direction = IN) =>
  isLikelyClosed({ preview, lastMessageDirection: direction });

test("bare thanks reads as closed", () => {
  assert.equal(closed("thanks"), true);
  assert.equal(closed("Thanks!"), true);
  assert.equal(closed("thank you so much"), true);
  assert.equal(closed("Thanks so much 🙏"), true);
  assert.equal(closed("Thanks for lending it to me that night"), true);
});

test("brief affirmatives read as closed", () => {
  assert.equal(closed("ok"), true);
  assert.equal(closed("Okay!"), true);
  assert.equal(closed("got it"), true);
  assert.equal(closed("noted"), true);
  assert.equal(closed("Sounds good"), true);
});

test("farewells read as closed", () => {
  assert.equal(closed("talk soon"), true);
  assert.equal(closed("have a great weekend"), true);
  assert.equal(closed("take care"), true);
});

test("pure emoji reactions read as closed", () => {
  assert.equal(closed("👍"), true);
  assert.equal(closed("🙏"), true);
  assert.equal(closed("❤️"), true);
});

test("a question or ask keeps the thread open even if it starts with thanks", () => {
  assert.equal(closed("thanks, can you also send me the link?"), false);
  assert.equal(closed("ok but when are we meeting?"), false);
  assert.equal(closed("got it - let me know about the rest"), false);
});

test("any question mark keeps the thread open", () => {
  assert.equal(closed("really?"), false);
  assert.equal(closed("where?"), false);
});

test("outbound previews are never classified as closed", () => {
  // The operator was last to speak, so it is the other party's turn.
  assert.equal(closed("thanks", OUT), false);
  assert.equal(closed("ok", OUT), false);
  assert.equal(closed("👍", OUT), false);
});

test("missing direction or empty preview leaves the thread open", () => {
  assert.equal(isLikelyClosed({ preview: "thanks" }), false);
  assert.equal(isLikelyClosed({ preview: "thanks", lastMessageDirection: null }), false);
  assert.equal(closed(""), false);
  assert.equal(closed(null), false);
  assert.equal(closed(undefined), false);
});

test("messages with substantive content do not auto-close on a stray closing word", () => {
  assert.equal(
    closed("ok i've thought about it and i don't think this works for us"),
    false
  );
  assert.equal(closed("thanks for the offer but it's not the right fit right now"), false);
});

test("placeholder previews never trip the classifier", () => {
  // normalizePreview maps these to human-friendly captions; neither
  // should look like an acknowledgement.
  assert.equal(closed("[system event]"), false);
  assert.equal(closed("[non-text message]"), false);
});

// Phase 2.5: AI verdict (closedStatus) overrides the regex heuristic.
test("AI verdict 'closed' overrides the heuristic even when preview looks open", () => {
  assert.equal(
    isLikelyClosed({
      preview: "hey, when are you free next week?",
      lastMessageDirection: IN,
      closedStatus: "closed"
    }),
    true
  );
});

test("AI verdict 'open' overrides bare thanks heuristic", () => {
  // Heuristic alone would mark this closed; AI saw the next-step plan
  // the cropped preview missed and decided the operator should reply.
  assert.equal(
    isLikelyClosed({
      preview: "thanks",
      lastMessageDirection: IN,
      closedStatus: "open"
    }),
    false
  );
});

test("strong closure preview beats stale AI open verdict", () => {
  assert.equal(
    isLikelyClosed({
      preview: "Thanks for lending it to me that night",
      lastMessageDirection: IN,
      closedStatus: "open"
    }),
    true
  );
});

test("missing AI verdict falls back to the heuristic", () => {
  assert.equal(
    isLikelyClosed({
      preview: "thanks",
      lastMessageDirection: IN,
      closedStatus: null
    }),
    true
  );
  assert.equal(
    isLikelyClosed({
      preview: "hey, what's up?",
      lastMessageDirection: IN,
      closedStatus: null
    }),
    false
  );
});

test("AI verdict 'open' wins over OUT-direction default", () => {
  // OUT normally means "waiting on them" -> not closed. The AI verdict
  // takes precedence either way, so an "open" verdict on an OUT row
  // still keeps it visible (no surprise).
  assert.equal(
    isLikelyClosed({
      preview: "you: sounds good",
      lastMessageDirection: OUT,
      closedStatus: "open"
    }),
    false
  );
});
