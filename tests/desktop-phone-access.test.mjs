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

test("phone access rotates its private pairing token on every launch", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "tovi-phone-token-"));
  try {
    const first = phoneAccess.rotateAccessToken(stateDir);
    const second = phoneAccess.rotateAccessToken(stateDir);
    assert.notEqual(first, second);
    assert.equal(phoneAccess.isValidAccessToken(first), true);
    assert.equal(readFileSync(join(stateDir, "phone-access-token"), "utf8").trim(), second);
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

    const insecure = await get(proxy.port, `/connect/${token}`);
    assert.equal(insecure.status, 400);

    const connected = await get(proxy.port, `/connect/${token}`, {
      "X-Forwarded-Proto": "https"
    });
    assert.equal(connected.status, 302);
    assert.equal(connected.headers.location, "/");
    assert.match(connected.headers["set-cookie"][0], /HttpOnly/);
    assert.match(connected.headers["set-cookie"][0], /SameSite=Strict/);
    assert.match(connected.headers["set-cookie"][0], /Secure/);
    const sessionCookie = connected.headers["set-cookie"][0].split(";", 1)[0];
    assert.notEqual(sessionCookie, `${phoneAccess.ACCESS_COOKIE}=${token}`);

    const opened = await get(proxy.port, "/inbox?q=reply", {
      Cookie: `${sessionCookie}; session=student`
    });
    assert.equal(opened.status, 200);
    assert.deepEqual(JSON.parse(opened.body), {
      cookie: "session=student",
      forwardedFor: "127.0.0.1",
      path: "/inbox?q=reply"
    });

    const reused = await get(proxy.port, `/connect/${token}`, {
      "X-Forwarded-Proto": "https"
    });
    assert.equal(reused.status, 401);
  } finally {
    await phoneAccess.stopPhoneAccessProxy(proxy.server);
    await close(upstream);
  }
});

test("secure phone access sets a secure cookie and keeps camera permission disabled", async () => {
  const upstream = createServer((_incoming, outgoing) => {
    outgoing.writeHead(200, { "Content-Type": "text/plain" });
    outgoing.end("ready");
  });
  const dashboardPort = await listen(upstream);
  const token = phoneAccess.createAccessToken();
  const proxy = await phoneAccess.startPhoneAccessProxy({
    dashboardPort,
    host: "127.0.0.1",
    preferredPort: 0,
    token
  });

  try {
    const connected = await get(proxy.port, `/connect/${token}`, {
      "X-Forwarded-Proto": "https"
    });
    assert.match(connected.headers["set-cookie"][0], /; Secure/);
    assert.equal(connected.headers["permissions-policy"], "camera=(), microphone=(self)");
    const sessionCookie = connected.headers["set-cookie"][0].split(";", 1)[0];

    const opened = await get(proxy.port, "/", {
      Cookie: sessionCookie
    });
    assert.equal(opened.headers["permissions-policy"], "camera=(), microphone=(self)");
  } finally {
    await phoneAccess.stopPhoneAccessProxy(proxy.server);
    await close(upstream);
  }
});

test("phone access links contain the pairing path", () => {
  const token = "a".repeat(43);
  assert.equal(
    phoneAccess.phoneAccessUrl("tovi.example.ts.net", 3111, token, "https"),
    `https://tovi.example.ts.net:3111/connect/${token}`
  );
  assert.throws(
    () => phoneAccess.phoneAccessUrl("192.168.1.4", 3110, token, "http"),
    /require HTTPS/
  );
});

test("Tailscale HTTPS is accepted only for an online MagicDNS node with HTTPS enabled", () => {
  const ready = {
    BackendState: "Running",
    CurrentTailnet: { MagicDNSEnabled: true },
    Self: {
      Capabilities: ["https"],
      DNSName: "tovi-mac.tail1234.ts.net.",
      Online: true
    }
  };
  assert.equal(phoneAccess.tailscalePhoneHost(ready), "tovi-mac.tail1234.ts.net");
  assert.equal(phoneAccess.tailscalePhoneHost({ ...ready, BackendState: "Stopped" }), "");
  assert.equal(
    phoneAccess.tailscalePhoneHost({
      ...ready,
      Self: { ...ready.Self, Capabilities: [] }
    }),
    ""
  );
});

test("secure phone access uses a dedicated free Serve port and never replaces an existing mapping", () => {
  const configuration = {
    TCP: { 443: { HTTPS: true }, 3111: { HTTPS: true } },
    Web: {
      "tovi-mac.tail1234.ts.net:443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:3100" } }
      },
      "tovi-mac.tail1234.ts.net:3111": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } }
      }
    }
  };
  assert.equal(phoneAccess.availableServePort(configuration, 3111), 3112);
  assert.equal(
    phoneAccess.matchingServePort(configuration, "http://127.0.0.1:9999"),
    3111
  );
});

test("launcher configures private Tailscale HTTPS around the authenticated proxy", () => {
  const calls = [];
  const status = {
    BackendState: "Running",
    CurrentTailnet: { MagicDNSEnabled: true },
    Self: {
      Capabilities: ["https"],
      DNSName: "tovi-mac.tail1234.ts.net.",
      Online: true
    }
  };
  const run = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "status") {
      return { status: 0, stdout: JSON.stringify(status), stderr: "" };
    }
    if (args[0] === "serve" && args[1] === "status") {
      return { status: 0, stdout: JSON.stringify({ TCP: {}, Web: {} }), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const token = "a".repeat(43);
  const secure = phoneAccess.startSecurePhoneAccess({
    env: { RIOS_TAILSCALE_PATH: "/test/tailscale" },
    platform: "darwin",
    proxyPort: 3110,
    run,
    token
  });
  assert.equal(secure.available, true);
  assert.equal(
    secure.url,
    `https://tovi-mac.tail1234.ts.net:3111/connect/${token}`
  );
  assert.deepEqual(calls.at(-1), [
    "/test/tailscale",
    ["serve", "--bg", "--yes", "--https=3111", "http://127.0.0.1:3110"]
  ]);

  phoneAccess.stopSecurePhoneAccess(secure, run);
  assert.deepEqual(calls.at(-1), [
    "/test/tailscale",
    ["serve", "--https=3111", "off"]
  ]);
});

test("the shared launcher owns phone access for source and packaged apps", () => {
  const source = readFileSync(new URL("../scripts/start-app.mjs", import.meta.url), "utf8");
  assert.match(source, /startPhoneAccessProxy/);
  assert.match(source, /startSecurePhoneAccess/);
  assert.match(source, /RIOS_PHONE_ACCESS_SECURE_URL/);
  assert.match(source, /RIOS_PHONE_ACCESS_PORT/);
  assert.match(source, /RIOS_PHONE_ACCESS_TOKEN/);
  assert.match(source, /stopPhoneAccessProxy\(phoneProxy\?\.server\)/);
  assert.match(source, /stopSecurePhoneAccess\(securePhoneAccess\)/);
});
