import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WhatsAppAdapter, extractPollPayload, renderMessageText } from "../apps/runner/dist/platforms/whatsapp-adapter.js";

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
      overrides.sendMessage ??
      (async () => ({ timestamp: 1700000100, id: { _serialized: "x" }, ack: 1 })),
    getMessageById: overrides.getMessageById ?? (async () => null),
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

test("incoming WhatsApp message includes a targeted thread hint", async () => {
  const client = createFakeClient();
  const changes = [];
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client,
    onIncomingMessage: (change) => changes.push(change)
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;

  client.emit("message", { from: "group@g.us", fromMe: false });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].platformThreadId, "group@g.us");
  assert.equal(Number.isFinite(Date.parse(changes[0].sourceChangedAt)), true);
});

test("scanUnreadThreads filters chats by unreadCount > 0", async () => {
  const chats = [
    { id: { _serialized: "a@c.us" }, name: "A", unreadCount: 0, isGroup: false },
    { id: { _serialized: "b@c.us" }, name: "B", unreadCount: 3, isGroup: false },
    { id: { _serialized: "g@g.us" }, name: "Group", unreadCount: 1, isGroup: true }
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
    ["b@c.us", "g@g.us"]
  );
  assert.equal(stubs[1].isGroup, true);
});

test("scanUnreadThreads reconnects once when WhatsApp replaces its browser frame", async () => {
  let firstDestroyed = false;
  const staleClient = createFakeClient({
    getChats: async () => {
      throw new Error("Attempted to use detached Frame '7EE3D604511108886782BA4502E441CD'.");
    },
    destroy: async () => {
      firstDestroyed = true;
    }
  });
  const liveClient = createFakeClient({
    getChats: async () => [
      { id: { _serialized: "a@c.us" }, name: "A", unreadCount: 0, isGroup: false },
      { id: { _serialized: "b@c.us" }, name: "B", unreadCount: 2, isGroup: false }
    ]
  });
  const clients = [staleClient, liveClient];
  const states = [];
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => clients.shift(),
    onStateChange: (state) => states.push(state)
  });

  const initialConnection = adapter.ensureConnected();
  setImmediate(() => staleClient.emit("ready"));
  await initialConnection;

  const scan = adapter.scanUnreadThreads();
  setImmediate(() => liveClient.emit("ready"));
  const threads = await scan;

  assert.equal(firstDestroyed, true);
  assert.deepEqual(threads.map((thread) => thread.platformThreadId), ["b@c.us"]);
  assert.deepEqual(states, ["connecting", "connected", "disconnected", "connecting", "connected"]);
});

test("poll actions invalidate a detached WhatsApp session", async () => {
  for (const action of ["vote", "view_votes"]) {
    let destroyed = false;
    const states = [];
    const client = createFakeClient({
      getMessageById: async () => {
        throw new Error("Attempted to use detached Frame '7EE3D604511108886782BA4502E441CD'.");
      },
      destroy: async () => {
        destroyed = true;
      }
    });
    const adapter = new WhatsAppAdapter({
      ...baseDeps(),
      createClient: () => client,
      onStateChange: (state) => states.push(state)
    });
    const ready = adapter.ensureConnected();
    setImmediate(() => client.emit("ready"));
    await ready;

    const pollAction = action === "vote"
      ? adapter.voteOnPoll(
          { platformThreadId: "a@c.us", displayName: "A", lastMessagePreview: "" },
          "poll-1",
          ["Yes"]
        )
      : adapter.getPollVotes(
          { platformThreadId: "a@c.us", displayName: "A", lastMessagePreview: "" },
          "poll-1"
        );

    await assert.rejects(pollAction, /WhatsApp lost its connection/);
    assert.equal(destroyed, true, action);
    assert.deepEqual(states, ["connecting", "connected", "disconnected"], action);
  }
});

test("scanUnreadThreads does not reconnect for unrelated collection failures", async () => {
  const client = createFakeClient({
    getChats: async () => {
      throw new Error("WhatsApp collection timed out");
    }
  });
  let factoryCalls = 0;
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => {
      factoryCalls += 1;
      return client;
    }
  });

  const connecting = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await connecting;

  await assert.rejects(adapter.scanUnreadThreads(), /collection timed out/);
  assert.equal(factoryCalls, 1);
});

test("fetchRecentThreads indexes every existing chat on the first sweep", async () => {
  const chats = Array.from({ length: 10 }, (_, i) => ({
    id: { _serialized: `c${i}@c.us` },
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
  assert.equal(stubs.length, 10);
});

test("fetchRecentThreads applies the requested limit after the initial index", async () => {
  const chats = Array.from({ length: 10 }, (_, i) => ({
    id: { _serialized: `c${i}@c.us` },
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
  await adapter.fetchRecentThreads(3);
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

test("sendMessage allows WhatsApp group sends even when the group is not a saved contact", async () => {
  let sentJid = null;
  let contactLookups = 0;
  const client = createFakeClient({
    getContactById: async () => {
      contactLookups += 1;
      return { isMyContact: false };
    },
    sendMessage: async (jid) => {
      sentJid = jid;
      return { timestamp: 1700000100, id: { _serialized: "group-msg-1" }, ack: 1 };
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
    {
      platformThreadId: "120363123456789@g.us",
      displayName: "Family group",
      lastMessagePreview: "",
      isGroup: true
    },
    "hello everyone"
  );

  assert.equal(sentJid, "120363123456789@g.us");
  assert.equal(contactLookups, 0);
  assert.equal(receipt.verifiedBy, "platform_acknowledged");
});

test("sendMessage delegates to client.sendMessage when the guard allows", async () => {
  let sentText = null;
  const client = createFakeClient({
    sendMessage: async (jid, text) => {
      sentText = text;
      assert.equal(jid, "447111222333@c.us");
      return { timestamp: 1700000100, id: { _serialized: "msg-1" }, ack: 1 };
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
  assert.equal(receipt.verifiedBy, "platform_acknowledged");
  assert.equal(receipt.platformMessageKey, "msg-1");
  assert.equal(receipt.sentAt, "2023-11-14T22:15:00.000Z");
});

test("sendPoll sends a native WhatsApp poll and returns structured metadata", async () => {
  let sentJid = null;
  let sentPoll = null;
  const client = createFakeClient({
    sendMessage: async (jid, content) => {
      sentJid = jid;
      sentPoll = content;
      return { timestamp: 1700000100, id: { _serialized: "poll-msg-1" }, ack: 1 };
    }
  });
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;

  const receipt = await adapter.sendPoll(
    { platformThreadId: "447111222333@c.us", displayName: "Alice", lastMessagePreview: "" },
    {
      question: "Dinner?",
      options: ["Yes", "No"],
      allowMultipleAnswers: true
    }
  );

  assert.equal(sentJid, "447111222333@c.us");
  assert.equal(sentPoll.pollName, "Dinner?");
  assert.deepEqual(sentPoll.pollOptions, [
    { name: "Yes", localId: 0 },
    { name: "No", localId: 1 }
  ]);
  assert.equal(sentPoll.options.allowMultipleAnswers, true);
  assert.equal(receipt.platformMessageKey, "poll-msg-1");
  assert.deepEqual(receipt.attachments, [
    {
      type: "poll",
      manualReview: false,
      rawLabel: "Dinner?",
      kind: "poll"
    }
  ]);
  assert.deepEqual(receipt.raw, {
    whatsapp: {
      poll: {
        question: "Dinner?",
        options: [{ name: "Yes" }, { name: "No" }],
        allowMultipleAnswers: true
      }
    }
  });
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

test("extractPollPayload returns structured poll metadata", () => {
  assert.deepEqual(
    extractPollPayload({
      type: "poll_creation",
      pollName: "Are you coming Friday?",
      pollOptions: [{ name: "Yes" }, { name: "No" }, { name: "" }],
      allowMultipleAnswers: true
    }),
    {
      question: "Are you coming Friday?",
      options: [{ name: "Yes" }, { name: "No" }],
      allowMultipleAnswers: true
    }
  );
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
  assert.deepEqual(msgs[0].raw, {
    whatsapp: {
      poll: {
        question: "When are we meeting?",
        options: [{ name: "Tuesday" }, { name: "Wednesday" }],
        allowMultipleAnswers: false
      }
    }
  });
  assert.deepEqual(msgs[0].attachments, [
    {
      type: "poll",
      manualReview: false,
      rawLabel: "When are we meeting?",
      kind: "poll"
    }
  ]);
});

test("voteOnPoll delegates to the wweb.js poll message vote API", async () => {
  let votedOptions = null;
  const client = createFakeClient({
    getMessageById: async (messageId) => {
      assert.equal(messageId, "m-poll");
      return {
        type: "poll_creation",
        vote: async (options) => {
          votedOptions = options;
        }
      };
    }
  });
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;
  await adapter.voteOnPoll(
    { platformThreadId: "x@c.us", displayName: "x", lastMessagePreview: "" },
    "m-poll",
    ["Tuesday"]
  );
  assert.deepEqual(votedOptions, ["Tuesday"]);
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

// --- #816 (R-0098): interval-blocked sends queue until clear instead of failing ---

test("sendMessage waits out the per-recipient interval and then sends (queued, not failed)", async () => {
  // First guard check sees a 24s-old outbound (30s interval -> ~6s
  // remaining); after the adapter sleeps the advertised remainder, the
  // re-check sees nothing recent and the send proceeds.
  let findFirstCalls = 0;
  const slept = [];
  let sentText = null;
  const client = createFakeClient({
    // ack: 1 -> already platform-acknowledged, so the #827 ack-wait
    // resolves immediately instead of waiting on a message_ack event.
    sendMessage: async (jid, text) => {
      sentText = text;
      return { timestamp: 1700000100, ack: 1, id: { _serialized: "msg-queued" } };
    }
  });
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    prisma: createFakePrisma({
      findFirst: async () => {
        findFirstCalls += 1;
        return findFirstCalls === 1 ? { timestamp: new Date(Date.now() - 24_000) } : null;
      }
    }),
    createClient: () => client,
    sleep: async (ms) => {
      slept.push(ms);
    }
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;

  const receipt = await adapter.sendMessage(
    { platformThreadId: "447111222333@c.us", displayName: "Cynthia", lastMessagePreview: "" },
    "queued follow-up"
  );

  assert.equal(sentText, "queued follow-up");
  assert.equal(receipt.verifiedBy, "platform_acknowledged");
  assert.equal(findFirstCalls, 2);
  assert.equal(slept.length, 1);
  // Waits the guard's advertised remainder (~6s) plus the 250ms buffer.
  assert.ok(slept[0] > 5_000 && slept[0] <= 6_000 + 250, `waited ${slept[0]}ms`);
});

test("sendPoll also waits out the per-recipient interval instead of failing", async () => {
  let findFirstCalls = 0;
  const slept = [];
  const client = createFakeClient({
    sendMessage: async () => ({ timestamp: 1700000100, ack: 1, id: { _serialized: "poll-queued" } })
  });
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    prisma: createFakePrisma({
      findFirst: async () => {
        findFirstCalls += 1;
        return findFirstCalls === 1 ? { timestamp: new Date(Date.now() - 5_000) } : null;
      }
    }),
    createClient: () => client,
    sleep: async (ms) => {
      slept.push(ms);
    }
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;

  const receipt = await adapter.sendPoll(
    { platformThreadId: "447111222333@c.us", displayName: "Cynthia", lastMessagePreview: "" },
    { question: "Sunday at 3?", options: ["Yes", "No"], allowMultipleAnswers: false }
  );

  assert.equal(receipt.verifiedBy, "platform_acknowledged");
  assert.equal(slept.length, 1);
});

test("non-waitable guard denials (daily cap) still fail immediately without sleeping", async () => {
  const slept = [];
  const client = createFakeClient();
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    prisma: createFakePrisma({ count: async () => 30 }),
    createClient: () => client,
    sleep: async (ms) => {
      slept.push(ms);
    }
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;

  await assert.rejects(
    adapter.sendMessage(
      { platformThreadId: "447111222333@c.us", displayName: "Cynthia", lastMessagePreview: "" },
      "over cap"
    ),
    /WhatsApp send blocked.*24h send cap reached/
  );
  assert.equal(slept.length, 0);
});

test("a wait that would exceed the bounded deadline fails instead of stacking sleeps", async () => {
  // Every check keeps reporting a freshly re-armed interval (something else
  // is actively sending to this recipient). The adapter must give up once
  // the deadline (one interval window + slack) would be exceeded, not loop.
  const slept = [];
  const client = createFakeClient();
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    prisma: createFakePrisma({
      // Always "just sent": full 30s remaining on every check.
      findFirst: async () => ({ timestamp: new Date(Date.now()) })
    }),
    createClient: () => client,
    sleep: async (ms) => {
      slept.push(ms);
    }
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;

  await assert.rejects(
    adapter.sendMessage(
      { platformThreadId: "447111222333@c.us", displayName: "Cynthia", lastMessagePreview: "" },
      "never clears"
    ),
    /WhatsApp send blocked.*Per-recipient send interval/
  );
  // Bounded: at most one interval window fits inside the deadline.
  assert.ok(slept.length <= 2, `slept ${slept.length} times`);
});

// --- #818 (R-0100): live poll tallies ---

test("getPollVotes maps wweb.js PollVote records with name resolution and self-detection", async () => {
  const client = createFakeClient({
    getMessageById: async (id) => {
      assert.equal(id, "poll-msg-1");
      return {
        type: "poll_creation",
        getPollVotes: async () => [
          {
            voter: "447111222333@c.us",
            selectedOptions: [{ name: "Yes" }],
            interractedAtTs: 1_780_000_000_000
          },
          {
            voter: "me@c.us",
            selectedOptions: [{ name: "Yes" }, { name: "No" }],
            interractedAtTs: 1_780_000_100_000
          },
          // Retracted vote (deselected everything) + unresolvable contact.
          { voter: "unknown@c.us", selectedOptions: [] }
        ]
      };
    },
    getContactById: async (jid) => {
      if (jid === "unknown@c.us") throw new Error("contact left");
      if (jid === "me@c.us") return { isMyContact: true, pushname: "", name: "" };
      return { isMyContact: true, pushname: "Cynthia", name: "Cynthia A" };
    }
  });
  client.info = { wid: { _serialized: "me@c.us" } };
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;

  const votes = await adapter.getPollVotes(
    { platformThreadId: "447111222333@c.us", displayName: "Cynthia", lastMessagePreview: "" },
    "poll-msg-1"
  );

  assert.deepEqual(votes, [
    {
      voterId: "447111222333@c.us",
      voterName: "Cynthia",
      isMe: false,
      selectedOptions: ["Yes"],
      votedAt: new Date(1_780_000_000_000).toISOString()
    },
    {
      voterId: "me@c.us",
      voterName: null,
      isMe: true,
      selectedOptions: ["Yes", "No"],
      votedAt: new Date(1_780_000_100_000).toISOString()
    },
    {
      voterId: "unknown@c.us",
      voterName: null,
      isMe: false,
      selectedOptions: [],
      votedAt: null
    }
  ]);
});

test("getPollVotes throws a readable error when the poll message cannot be found", async () => {
  const client = createFakeClient({ getMessageById: async () => null });
  const adapter = new WhatsAppAdapter({
    ...baseDeps(),
    createClient: () => client
  });
  const ready = adapter.ensureConnected();
  setImmediate(() => client.emit("ready"));
  await ready;

  await assert.rejects(
    adapter.getPollVotes(
      { platformThreadId: "447111222333@c.us", displayName: "Cynthia", lastMessagePreview: "" },
      "gone"
    ),
    /poll message not found/
  );
});
