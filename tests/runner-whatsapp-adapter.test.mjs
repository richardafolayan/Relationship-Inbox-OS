import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  WhatsAppAdapter,
  renderMessageText,
  looksLikeBase64Media
} from "../apps/runner/dist/platforms/whatsapp-adapter.js";

/**
 * Minimal whatsapp-web.js Client stub. Wweb.js Client extends EventEmitter
 * (`on(event, cb)`) and exposes initialize / destroy / getChats / getChatById
 * / sendMessage / getContactById on the prototype. We mirror that surface.
 */
function createFakeClient(overrides = {}) {
  const ee = new EventEmitter();
  const client = Object.assign(ee, {
    initialize: overrides.initialize ?? (async () => undefined),
    destroy: overrides.destroy ?? (async () => undefined),
    getChats: overrides.getChats ?? (async () => []),
    getChatById: overrides.getChatById ?? (async () => null),
    sendMessage:
      overrides.sendMessage ?? (async () => ({ timestamp: 1700000100, id: { _serialized: "x" } })),
    getContactById:
      overrides.getContactById ??
      (async () => ({ isMyContact: true, pushname: "Alice", name: "Alice" }))
  });
  return client;
}

function createFakePrisma(overrides = {}) {
  return {
    message: {
      findFirst: overrides.findFirst ?? (async () => null),
      count: overrides.count ?? (async () => 0)
    }
  };
}

const baseDeps = () => ({
  authDir: "/tmp/wa-test",
  sendGuardConfig: { minIntervalMs: 30_000, dailyCap: 30 },
  prisma: createFakePrisma()
});

test("WhatsAppAdapter conforms to the PlatformAdapter contract", () => {
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => createFakeClient()
  });
  assert.equal(adapter.platform, "WHATSAPP");
  assert.equal(typeof adapter.ensureConnected, "function");
  assert.equal(typeof adapter.scanUnreadThreads, "function");
  assert.equal(typeof adapter.fetchRecentThreads, "function");
  assert.equal(typeof adapter.fetchThreadMessages, "function");
  assert.equal(typeof adapter.sendMessage, "function");
  assert.equal(typeof adapter.openThread, "function");
  assert.equal(typeof adapter.closeSession, "function");
});

test("ensureConnected resolves when the client emits 'ready'", async () => {
  const client = createFakeClient();
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client
  });
  const connecting = adapter.ensureConnected();
  // Library would fire "ready" after auth completes — simulate it.
  setImmediate(() => client.emit("ready"));
  await connecting;
});

test("ensureConnected rejects when the client emits 'auth_failure'", async () => {
  const client = createFakeClient();
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client
  });
  const connecting = adapter.ensureConnected();
  setImmediate(() => client.emit("auth_failure", "session expired"));
  await assert.rejects(connecting, /WhatsApp auth_failure: session expired/);
});

test("ensureConnected forwards QR codes via onQr and onStateChange", async () => {
  const client = createFakeClient();
  const states = [];
  let qr = null;
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client,
    onQr: (q) => {
      qr = q;
    },
    onStateChange: (s) => {
      states.push(s);
    }
  });
  const connecting = adapter.ensureConnected();
  // Connecting → qr_ready → connected.
  setImmediate(() => {
    client.emit("qr", "QR-DATA-STRING");
    client.emit("ready");
  });
  await connecting;
  assert.equal(qr, "QR-DATA-STRING");
  assert.deepEqual(states, ["connecting", "qr_ready", "connected"]);
});

test("ensureConnected is idempotent — second call returns the same in-flight promise", async () => {
  let initCount = 0;
  const client = createFakeClient({
    initialize: async () => {
      initCount += 1;
    }
  });
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client
  });
  const a = adapter.ensureConnected();
  const b = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await Promise.all([a, b]);
  assert.equal(initCount, 1);
});

test("scanUnreadThreads filters chats by unreadCount > 0", async () => {
  const chats = [
    { id: { _serialized: "447000000001@c.us" }, name: "A", unreadCount: 0, isGroup: false },
    { id: { _serialized: "447000000002@c.us" }, name: "B", unreadCount: 3, isGroup: false },
    { id: { _serialized: "12345-67890@g.us" }, name: "Group", unreadCount: 1, isGroup: true }
  ];
  const client = createFakeClient({ getChats: async () => chats });
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;
  const stubs = await adapter.scanUnreadThreads();
  assert.equal(stubs.length, 2);
  assert.deepEqual(
    stubs.map((s) => s.platformThreadId),
    ["447000000002@c.us", "12345-67890@g.us"]
  );
  assert.equal(stubs[1].isGroup, true);
});

test("fetchRecentThreads slices to the requested limit", async () => {
  const chats = Array.from({ length: 10 }, (_, i) => ({
    id: { _serialized: `44700000${String(i).padStart(4, "0")}@c.us` },
    name: `C${i}`,
    isGroup: false,
    unreadCount: 0
  }));
  const client = createFakeClient({ getChats: async () => chats });
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;
  const stubs = await adapter.fetchRecentThreads(3);
  assert.equal(stubs.length, 3);
});

test("sendMessage refuses to send when the guard blocks (non-saved contact)", async () => {
  const client = createFakeClient({
    getContactById: async () => ({ isMyContact: false })
  });
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;
  await assert.rejects(
    adapter.sendMessage(
      { platformThreadId: "stranger@c.us", displayName: "?", lastMessagePreview: "" },
      "hi"
    ),
    /WhatsApp send blocked.*not in your WhatsApp saved contacts/
  );
});

test("sendMessage delegates to client.sendMessage when the guard allows", async () => {
  let sentText = null;
  const client = createFakeClient({
    sendMessage: async (jid, text) => {
      sentText = text;
      assert.equal(jid, "447111222333@c.us");
      return { timestamp: 1700000100, id: { _serialized: "msg-1" } };
    }
  });
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;
  const receipt = await adapter.sendMessage(
    { platformThreadId: "447111222333@c.us", displayName: "Alice", lastMessagePreview: "" },
    "hello"
  );
  assert.equal(sentText, "hello");
  assert.equal(receipt.verifiedBy, "best_effort");
  assert.equal(receipt.sentAt, "2023-11-14T22:15:00.000Z");
});

test("fetchThreadMessages normalises wweb.js Message shapes (1:1)", async () => {
  const fakeChat = {
    fetchMessages: async () => [
      {
        id: { _serialized: "m1" },
        body: "hello",
        timestamp: 1700000000,
        fromMe: false,
        hasMedia: false
      },
      {
        id: { _serialized: "m2" },
        body: "yo",
        timestamp: 1700000010,
        fromMe: true,
        hasMedia: false
      }
    ]
  };
  const client = createFakeClient({ getChatById: async () => fakeChat });
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;
  const msgs = await adapter.fetchThreadMessages(
    {
      platformThreadId: "447111222333@c.us",
      displayName: "Alice",
      lastMessagePreview: "",
      isGroup: false
    },
    50
  );
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].direction, "IN");
  assert.equal(msgs[0].text, "hello");
  assert.equal(msgs[0].timestamp, "2023-11-14T22:13:20.000Z");
  assert.equal(msgs[1].direction, "OUT");
  assert.equal(msgs[1].senderName, undefined);
});

test("fetchThreadMessages populates senderName for inbound group messages via msg.author lookup", async () => {
  const fakeChat = {
    fetchMessages: async () => [
      {
        id: { _serialized: "m1" },
        body: "who's driving",
        timestamp: 1700000000,
        fromMe: false,
        hasMedia: false,
        author: "447999888777@c.us"
      }
    ]
  };
  const client = createFakeClient({
    getChatById: async () => fakeChat,
    getContactById: async (jid) => {
      assert.equal(jid, "447999888777@c.us");
      return { isMyContact: true, pushname: "Bob", name: "Bob" };
    }
  });
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;
  const msgs = await adapter.fetchThreadMessages(
    {
      platformThreadId: "12345-67890@g.us",
      displayName: "Lads",
      lastMessagePreview: "",
      isGroup: true
    },
    10
  );
  assert.equal(msgs[0].senderName, "Bob");
});

test("renderMessageText flattens a poll_creation message into question + bullet list", () => {
  const text = renderMessageText({
    type: "poll_creation",
    pollName: "Are you coming Friday?",
    pollOptions: [{ name: "Yes" }, { name: "No" }, { name: "Maybe" }]
  });
  assert.match(text, /^📊 Poll: Are you coming Friday\?/);
  assert.match(text, /• Yes/);
  assert.match(text, /• No/);
  assert.match(text, /• Maybe/);
});

test("renderMessageText marks multi-select polls", () => {
  const text = renderMessageText({
    type: "poll_creation",
    pollName: "Pick toppings",
    pollOptions: [{ name: "Pepperoni" }, { name: "Mushroom" }],
    allowMultipleAnswers: true
  });
  assert.match(text, /^📊 Poll \(multi-select\): Pick toppings/);
});

test("renderMessageText handles polls with no question", () => {
  const text = renderMessageText({
    type: "poll_creation",
    pollOptions: [{ name: "Option A" }]
  });
  assert.equal(text, "📊 Poll\n• Option A");
});

test("renderMessageText falls through to media / body / empty for non-poll types", () => {
  assert.equal(renderMessageText({ body: "hi" }), "hi");
  assert.equal(renderMessageText({ hasMedia: true }), "[media]");
  assert.equal(renderMessageText({}), "");
  // body wins over hasMedia
  assert.equal(renderMessageText({ body: "caption", hasMedia: true }), "caption");
});

test("renderMessageText replaces a base64 image body with a placeholder", () => {
  // The WhatsApp system account (0@c.us) puts a raw base64 JPEG in body.
  const jpeg = "/9j/4AAQSkZJRgABAQEAYABgAAD" + "A".repeat(400);
  assert.equal(renderMessageText({ body: jpeg }), "[image]");
  const png = "iVBORw0KGgoAAAANSUhEUg" + "B".repeat(400);
  assert.equal(renderMessageText({ body: png }), "[image]");
});

test("looksLikeBase64Media is conservative — never trips on real text", () => {
  assert.equal(looksLikeBase64Media("hey, are we still on for 8pm?"), false);
  // A long ordinary message has spaces, so it's never mistaken for base64.
  assert.equal(looksLikeBase64Media("thanks so much ".repeat(40)), false);
  // A short token that happens to be base64-ish is left alone.
  assert.equal(looksLikeBase64Media("Y2F0"), false);
  // A genuine long base64 blob is caught.
  assert.equal(looksLikeBase64Media("QUJD".repeat(80)), true);
});

test("fetchThreadMessages renders a poll_creation message via renderMessageText", async () => {
  const fakeChat = {
    fetchMessages: async () => [
      {
        id: { _serialized: "m-poll" },
        body: "",
        timestamp: 1700000000,
        fromMe: false,
        hasMedia: false,
        type: "poll_creation",
        pollName: "When are we meeting?",
        pollOptions: [{ name: "Tuesday" }, { name: "Wednesday" }]
      }
    ]
  };
  const client = createFakeClient({ getChatById: async () => fakeChat });
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;
  const msgs = await adapter.fetchThreadMessages(
    { platformThreadId: "x@c.us", displayName: "x", lastMessagePreview: "" },
    1
  );
  assert.match(msgs[0].text, /When are we meeting\?/);
  assert.match(msgs[0].text, /• Tuesday/);
  assert.match(msgs[0].text, /• Wednesday/);
});

test("fetchThreadMessages substitutes [media] placeholder for messages with hasMedia and no body", async () => {
  const fakeChat = {
    fetchMessages: async () => [
      {
        id: { _serialized: "m1" },
        body: "",
        timestamp: 1700000000,
        fromMe: false,
        hasMedia: true
      }
    ]
  };
  const client = createFakeClient({ getChatById: async () => fakeChat });
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;
  const msgs = await adapter.fetchThreadMessages(
    { platformThreadId: "x@c.us", displayName: "x", lastMessagePreview: "" },
    1
  );
  assert.equal(msgs[0].text, "[media]");
});

test("openThread is a no-op (resolves cleanly)", async () => {
  const client = createFakeClient();
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;
  await adapter.openThread({
    platformThreadId: "x@c.us",
    displayName: "x",
    lastMessagePreview: ""
  });
});

test("closeSession destroys the client and emits the disconnected state", async () => {
  let destroyed = false;
  const client = createFakeClient({
    destroy: async () => {
      destroyed = true;
    }
  });
  const states = [];
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client,
    onStateChange: (s) => states.push(s)
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;
  await adapter.closeSession();
  assert.equal(destroyed, true);
  // Last transition is to disconnected.
  assert.equal(states[states.length - 1], "disconnected");
});

test("closeSession still emits disconnected when no client was ever constructed", async () => {
  // Regression: previously closeSession early-returned if this.client was
  // null, leaving the in-memory state machine stuck (e.g. mid-failed
  // ensureConnected). Operator's only recovery was a runner restart.
  const states = [];
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => createFakeClient(),
    onStateChange: (s) => states.push(s)
  });
  // No ensureConnected — this.client is null.
  await adapter.closeSession();
  assert.deepEqual(states, ["disconnected"]);
});

test("closeSession allows a fresh ensureConnected to proceed after a stuck mid-connect", async () => {
  // Without the unconditional reset, readyPromise from a stuck connect
  // would short-circuit subsequent ensureConnected calls. Verify the
  // state machine is fully recoverable via a reset + reconnect cycle.
  const firstClient = createFakeClient();
  const secondClient = createFakeClient();
  let createCalls = 0;
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => {
      createCalls += 1;
      return createCalls === 1 ? firstClient : secondClient;
    }
  });
  // Start a connect but never resolve it (stuck mid-flight).
  const stuck = adapter.ensureConnected();
  // Tear down without resolution.
  await adapter.closeSession();
  // The stuck promise needs to be settled so we don't leak it; firstClient
  // never emitted ready, but closeSession's reject won't fire either since
  // we cleared readyPromise. Detach it.
  stuck.catch(() => undefined);
  // Fresh connect should construct a NEW client and reach ready cleanly.
  const fresh = adapter.ensureConnected();
  setImmediate(() => secondClient.emit("ready"));
  await fresh;
  assert.equal(createCalls, 2);
});

test("scanUnreadThreads throws a clear error when called before ensureConnected", async () => {
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => createFakeClient()
  });
  await assert.rejects(adapter.scanUnreadThreads(), /not connected/);
});

test("onIncomingMessage fires when the client emits a 'message' event", async () => {
  const client = createFakeClient();
  let hits = 0;
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client,
    onIncomingMessage: () => {
      hits += 1;
    }
  });
  const connecting = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await connecting;
  // wweb.js emits "message" only for inbound (non-fromMe) messages; each one
  // nudges the runner to enqueue a debounced scan.
  client.emit("message", {});
  client.emit("message", {});
  assert.equal(hits, 2);
});

test("a throwing onIncomingMessage never bubbles into the wweb.js event loop", async () => {
  const client = createFakeClient();
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client,
    onIncomingMessage: () => {
      throw new Error("scan enqueue blew up");
    }
  });
  const connecting = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await connecting;
  // Must not throw — the adapter swallows listener errors.
  assert.doesNotThrow(() => client.emit("message", {}));
});

test("no 'message' listener is attached when onIncomingMessage is omitted", async () => {
  const client = createFakeClient();
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client
  });
  const connecting = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await connecting;
  assert.equal(client.listenerCount("message"), 0);
});

test("scanUnreadThreads drops ONLY the system account and broadcasts", async () => {
  const chats = [
    { id: { _serialized: "447111222333@c.us" }, name: "Real Person", unreadCount: 2 },
    { id: { _serialized: "998877@lid" }, name: "LID Contact", unreadCount: 4 },
    { id: { _serialized: "0@c.us" }, name: "WhatsApp", unreadCount: 5 },
    { id: { _serialized: "status@broadcast" }, name: "Status", unreadCount: 3 },
    { id: { _serialized: "12345-67890@g.us" }, name: "A Group", isGroup: true, unreadCount: 1 }
  ];
  const client = createFakeClient({ getChats: async () => chats });
  const adapter = new WhatsAppAdapter({ ...baseDeps(), createClient: () => client });
  const connecting = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await connecting;
  const stubs = await adapter.scanUnreadThreads();
  const ids = stubs.map((s) => s.platformThreadId).sort();
  // @lid contact is kept (unrecognised domain != system); only 0@c.us and
  // status@broadcast are dropped.
  assert.deepEqual(ids, ["12345-67890@g.us", "447111222333@c.us", "998877@lid"]);
});

test("fetchRecentThreads filters only system/broadcast before applying the limit", async () => {
  const chats = [
    { id: { _serialized: "0@c.us" }, name: "WhatsApp" },
    { id: { _serialized: "status@broadcast" }, name: "Status" },
    { id: { _serialized: "447111222333@c.us" }, name: "Real Person" },
    { id: { _serialized: "998877@lid" }, name: "LID Contact" }
  ];
  const client = createFakeClient({ getChats: async () => chats });
  const adapter = new WhatsAppAdapter({ ...baseDeps(), createClient: () => client });
  const connecting = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await connecting;
  // limit 2 must return the two REAL chats, not be consumed by the two
  // filtered-out system/broadcast entries that sort first.
  const stubs = await adapter.fetchRecentThreads(2);
  const ids = stubs.map((s) => s.platformThreadId).sort();
  assert.deepEqual(ids, ["447111222333@c.us", "998877@lid"]);
});
