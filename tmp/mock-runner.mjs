// Mock runner for browser-verifying the #476 one-box transcribe morph.
// Serves just enough of the runner API for the thread page to render and
// for the dictation flow to run end-to-end without a real runner.
import http from "node:http";

const PORT = Number(process.env.PORT || 4457);

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const thread = {
  id: "t-verify-1",
  personId: "p-verify-1",
  personName: "Joseph Kolo",
  personAvatarUrl: null,
  personFavourite: false,
  platform: "IMESSAGE",
  siblingIds: ["t-verify-1"],
  riskLevel: "GREEN",
  riskReason: null,
  snoozedUntil: null,
  unreadCount: 1,
  needsReply: true,
  summary: "Catching up after the Costco run.",
  whatTheyWant: "He let you know where he was parked.",
  openLoops: [],
  dismissedOpenLoops: [],
  toneNotes: [],
  remember: [],
  replyBrief: null,
  receipts: [],
  draft: "",
  contextUpdatedAt: iso(60_000),
  messages: [
    {
      id: "m1",
      direction: "IN",
      timestamp: iso(7_200_000),
      text: "Red car",
      senderName: "Joseph Kolo",
      attachments: []
    },
    {
      id: "m2",
      direction: "OUT",
      timestamp: iso(7_100_000),
      text: "Oh okay",
      attachments: []
    },
    {
      id: "m3",
      direction: "IN",
      timestamp: iso(7_000_000),
      text: "On the other side",
      senderName: "Joseph Kolo",
      attachments: []
    }
  ],
  messagePage: { hasOlder: false, olderCursor: null, limit: 60 },
  suggestedReplies: { replies: [], needs_user_input: [] },
  suggestedRepliesStatus: "ready",
  scheduledSends: [],
  lastInboundAt: iso(7_000_000),
  lastOutboundAt: iso(7_100_000)
};

const json = (res, body, status = 200) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*"
  });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  // SSE: the ": connected" hello is load-bearing.
  if (p === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    res.write(": connected\n\n");
    return; // keep open
  }
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (p === "/control/transcribe-dictation") {
        // FAIL_FIRST: 503 the first attempt so the retry banner can be
        // exercised; the retried clip then succeeds.
        if (process.env.FAIL_FIRST && !global.__failed) {
          global.__failed = true;
          return json(res, { ok: false, error: "transcription backend unavailable" }, 502);
        }
        // Simulate a short transcription delay so the shimmer is visible.
        setTimeout(
          () =>
            json(res, {
              ok: true,
              text: "hey joe wanted to say thank you for yesterday the costco run was really kind of you"
            }),
          1200
        );
        return;
      }
      if (/^\/control\/thread\/[^/]+\/compose$/.test(p)) {
        setTimeout(
          () =>
            json(res, {
              text: "Hey Joe, just wanted to say thank you for yesterday. Taking us to Costco was really kind of you, I appreciate it man."
            }),
          1200
        );
        return;
      }
      json(res, { ok: true });
    });
    return;
  }
  if (p === "/health") return json(res, { ok: true, platforms: [] });
  if (p === "/data/platforms") return json(res, []);
  if (p.startsWith("/data/logs")) return json(res, []);
  if (p === "/data/send-queue") return json(res, { pending: [], recent: [] });
  if (p === "/data/birthdays") return json(res, []);
  if (p === "/data/inbox") return json(res, { rows: [] });
  if (p === "/data/transcription-capabilities")
    return json(res, { dictationAvailable: true });
  if (p === "/data/operator-profile")
    return json(res, {
      displayName: "Richard",
      aiHelpLevel: process.env.TIER || "full_drafts"
    });
  if (p.startsWith("/data/thread/")) return json(res, thread);
  if (p.startsWith("/data/overdue-digest")) return json(res, { items: [] });
  if (p.startsWith("/data/")) return json(res, {});
  json(res, { ok: true });
});

server.listen(PORT, () => console.log(`mock runner on :${PORT}`));
