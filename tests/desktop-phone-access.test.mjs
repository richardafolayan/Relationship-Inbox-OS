import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const phoneAccess = require("../apps/desktop/phone-access.cjs");

function listen(server, port = 0) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolveClose) => server.close(resolveClose));
}

function get(port, path = "/", headers = {}) {
  return new Promise((resolveGet, rejectGet) => {
    const handle = request({ hostname: "127.0.0.1", port, path, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolveGet({ body, headers: response.headers, status: response.statusCode }));
    });
    handle.on("error", rejectGet);
    handle.end();
  });
}

test("phone access keeps a stable private token outside the app bundle", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "tovi-phone-token-"));
  try {
    const first = phoneAccess.readOrCreateAccessToken(stateDir);
    const second = phoneAccess.readOrCreateAccessToken(stateDir);
    assert.equal(first, second);
    assert.equal(phoneAccess.isValidAccessToken(first), true);
    assert.equal(readFileSync(join(stateDir, "phone-access-token"), "utf8").trim(), first);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("phone access lists private Wi-Fi addresses before other adapters", () => {
  assert.deepEqual(phoneAccess.lanIpv4Addresses({
    bridge0: [{ address: "192.168.64.1", family: "IPv4", internal: false }],
    en0: [
      { address: "fe80::1", family: "IPv6", internal: false },
      { address: "192.168.1.4", family: "IPv4", internal: false }
    ],
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    utun3: [{ address: "203.0.113.5", family: "IPv4", internal: false }]
  }), ["192.168.1.4", "192.168.64.1"]);
});

test("phone access requires the private link before proxying dashboard requests", async () => {
  const upstream = createServer((incoming, outgoing) => {
    outgoing.writeHead(200, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({
      cookie: incoming.headers.cookie || "",
      forwardedFor: incoming.headers["x-forwarded-for"],
      path: incoming.url
    }));
  });
  const dashboardPort = await listen(upstream);
  const token = phoneAccess.createAccessToken();
  const proxy = await phoneAccess.startPhoneAccessProxy({
    appName: "Tovi",
    dashboardPort,
    host: "127.0.0.1",
    preferredPort: 0,
    token
  });

  try {
    const locked = await get(proxy.port);
    assert.equal(locked.status, 401);
    assert.match(locked.body, /Tovi is locked/);

    const connected = await get(proxy.port, `/connect/${token}`);
    assert.equal(connected.status, 302);
    assert.equal(connected.headers.location, "/");
    assert.match(connected.headers["set-cookie"][0], /HttpOnly/);
    assert.match(connected.headers["set-cookie"][0], /SameSite=Strict/);

    const opened = await get(proxy.port, "/inbox?q=reply", {
      Cookie: `${phoneAccess.ACCESS_COOKIE}=${token}; session=student`
    });
    assert.equal(opened.status, 200);
    assert.deepEqual(JSON.parse(opened.body), {
      cookie: "session=student",
      forwardedFor: "127.0.0.1",
      path: "/inbox?q=reply"
    });
  } finally {
    await phoneAccess.stopPhoneAccessProxy(proxy.server);
    await close(upstream);
  }
});

test("phone access links contain the pairing path", () => {
  const token = "a".repeat(43);
  assert.equal(
    phoneAccess.phoneAccessUrl("192.168.1.4", 3110, token),
    `http://192.168.1.4:3110/connect/${token}`
  );
});

test("the shared launcher owns phone access for source and packaged apps", () => {
  const source = readFileSync(new URL("../scripts/start-app.mjs", import.meta.url), "utf8");
  assert.match(source, /startPhoneAccessProxy/);
  assert.match(source, /RIOS_PHONE_ACCESS_PORT/);
  assert.match(source, /RIOS_PHONE_ACCESS_TOKEN/);
  assert.match(source, /stopPhoneAccessProxy\(phoneProxy\?\.server\)/);
});
