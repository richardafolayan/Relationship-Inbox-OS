const { randomBytes, timingSafeEqual } = require("node:crypto");
const { readFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { createServer, request } = require("node:http");
const { join } = require("node:path");

const ACCESS_COOKIE = "tovi_phone_access";
const ACCESS_TOKEN_FILE = "phone-access-token";
const DEFAULT_PHONE_PORT = 3110;

function isPrivateIpv4(address) {
  const parts = String(address).split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

function lanIpv4Addresses(interfaces) {
  const addresses = [];
  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      const family = entry?.family === 4 ? "IPv4" : entry?.family;
      if (family !== "IPv4" || entry.internal || !isPrivateIpv4(entry.address)) continue;
      addresses.push({
        address: entry.address,
        name,
        priority: /^(en0|wi-?fi|wlan)/i.test(name) ? 0 : 1
      });
    }
  }
  return addresses
    .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name))
    .map((entry) => entry.address)
    .filter((address, index, all) => all.indexOf(address) === index);
}

function createAccessToken() {
  return randomBytes(32).toString("base64url");
}

function isValidAccessToken(token) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

function readOrCreateAccessToken(stateDir) {
  const tokenPath = join(stateDir, ACCESS_TOKEN_FILE);
  try {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (isValidAccessToken(existing)) return existing;
  } catch {}
  mkdirSync(stateDir, { recursive: true });
  const token = createAccessToken();
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

function phoneAccessUrl(address, port, token) {
  return `http://${address}:${port}/connect/${token}`;
}

function cookieValue(header, name) {
  for (const pair of String(header || "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    return pair.slice(separator + 1).trim();
  }
  return "";
}

function tokensMatch(left, right) {
  if (!isValidAccessToken(left) || !isValidAccessToken(right)) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function stripAccessCookie(header) {
  return String(header || "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair && pair.slice(0, pair.indexOf("=")).trim() !== ACCESS_COOKIE)
    .join("; ");
}

function lockedPage(appName) {
  const safeName = String(appName).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeName}</title><style>body{margin:0;background:#0f1115;color:#f5f1e8;font:16px -apple-system,BlinkMacSystemFont,sans-serif;display:grid;min-height:100vh;place-items:center}main{max-width:360px;padding:32px;text-align:center}p{color:#b9b2a6;line-height:1.5}</style></head><body><main><h1>${safeName} is locked</h1><p>On your computer, open ${safeName} and choose Use ${safeName} on Your Phone from the app menu.</p></main></body></html>`;
}

function proxyHandler({ appName, dashboardPort, token }) {
  return (incoming, outgoing) => {
    let pathname = "/";
    try {
      pathname = new URL(incoming.url || "/", "http://phone.local").pathname;
    } catch {}

    if (incoming.method === "GET" && pathname === `/connect/${token}`) {
      outgoing.writeHead(302, {
        "Cache-Control": "no-store",
        Location: "/",
        "Set-Cookie": `${ACCESS_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`
      });
      outgoing.end();
      return;
    }

    if (!tokensMatch(cookieValue(incoming.headers.cookie, ACCESS_COOKIE), token)) {
      const body = lockedPage(appName);
      outgoing.writeHead(401, {
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(body),
        "Content-Type": "text/html; charset=utf-8"
      });
      outgoing.end(body);
      return;
    }

    const headers = { ...incoming.headers };
    const forwardedCookie = stripAccessCookie(headers.cookie);
    if (forwardedCookie) headers.cookie = forwardedCookie;
    else delete headers.cookie;
    headers["x-forwarded-for"] = incoming.socket.remoteAddress || "";

    const upstream = request({
      hostname: "127.0.0.1",
      port: dashboardPort,
      method: incoming.method,
      path: incoming.url,
      headers
    }, (response) => {
      outgoing.writeHead(response.statusCode || 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => {
      if (outgoing.headersSent) outgoing.destroy();
      else {
        outgoing.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "2" });
        outgoing.end(`${appName} is still starting. Try again in a moment.`);
      }
    });
    incoming.on("aborted", () => upstream.destroy());
    incoming.pipe(upstream);
  };
}

function listen(handler, port, host) {
  return new Promise((resolveListen, rejectListen) => {
    const server = createServer(handler);
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.removeListener("error", rejectListen);
      const address = server.address();
      resolveListen({ server, port: typeof address === "object" && address ? address.port : port });
    });
  });
}

async function startPhoneAccessProxy({
  appName = "Tovi",
  dashboardPort,
  host = "0.0.0.0",
  preferredPort = DEFAULT_PHONE_PORT,
  token
}) {
  if (!isValidAccessToken(token)) throw new Error("Phone access requires a valid private token.");
  const handler = proxyHandler({ appName, dashboardPort, token });
  try {
    return await listen(handler, preferredPort, host);
  } catch (error) {
    if (error?.code !== "EADDRINUSE" || preferredPort === 0) throw error;
    return listen(handler, 0, host);
  }
}

function stopPhoneAccessProxy(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolveStop) => {
    server.close(() => resolveStop());
    server.closeAllConnections?.();
  });
}

module.exports = {
  ACCESS_COOKIE,
  DEFAULT_PHONE_PORT,
  createAccessToken,
  isPrivateIpv4,
  isValidAccessToken,
  lanIpv4Addresses,
  phoneAccessUrl,
  readOrCreateAccessToken,
  startPhoneAccessProxy,
  stopPhoneAccessProxy,
  tokensMatch
};
