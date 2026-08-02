const { randomBytes, timingSafeEqual } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
const { createServer, request } = require("node:http");
const { join } = require("node:path");

const ACCESS_COOKIE = "tovi_phone_access";
const ACCESS_TOKEN_FILE = "phone-access-token";
const DEFAULT_PHONE_PORT = 3110;
const DEFAULT_SECURE_PHONE_PORT = 3111;
const SECURE_PHONE_PORT_ATTEMPTS = 10;

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

function rotateAccessToken(stateDir) {
  const tokenPath = join(stateDir, ACCESS_TOKEN_FILE);
  mkdirSync(stateDir, { recursive: true });
  const token = createAccessToken();
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

function phoneAccessUrl(address, port, token, protocol = "https") {
  if (protocol !== "https") {
    throw new Error("Phone access links require HTTPS.");
  }
  return `${protocol}://${address}:${port}/connect/${token}`;
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
  let pairingAvailable = true;
  const sessions = new Set();
  return (incoming, outgoing) => {
    let pathname = "/";
    try {
      pathname = new URL(incoming.url || "/", "http://phone.local").pathname;
    } catch {}

    if (incoming.method === "GET" && pathname === `/connect/${token}` && pairingAvailable) {
      const forwardedProtocol = String(incoming.headers["x-forwarded-proto"] || "")
        .split(",", 1)[0]
        .trim()
        .toLowerCase();
      const secureCookie = forwardedProtocol === "https" || Boolean(incoming.socket.encrypted);
      if (!secureCookie) {
        outgoing.writeHead(400, { "Cache-Control": "no-store" });
        outgoing.end("Phone pairing requires the secure Tailscale address.");
        return;
      }
      const session = createAccessToken();
      sessions.add(session);
      pairingAvailable = false;
      outgoing.writeHead(302, {
        "Cache-Control": "no-store",
        Location: "/",
        "Permissions-Policy": "camera=(), microphone=(self)",
        "Set-Cookie": `${ACCESS_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000; Secure`
      });
      outgoing.end();
      return;
    }

    const session = cookieValue(incoming.headers.cookie, ACCESS_COOKIE);
    if (![...sessions].some((candidate) => tokensMatch(session, candidate))) {
      const body = lockedPage(appName);
      outgoing.writeHead(401, {
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(body),
        "Content-Type": "text/html; charset=utf-8",
        "Permissions-Policy": "camera=(), microphone=()"
      });
      outgoing.end(body);
      return;
    }

    const headers = { ...incoming.headers };
    const forwardedCookie = stripAccessCookie(headers.cookie);
    if (forwardedCookie) headers.cookie = forwardedCookie;
    else delete headers.cookie;
    headers["x-forwarded-for"] = incoming.socket.remoteAddress || "";
    delete headers["tailscale-user-login"];
    delete headers["tailscale-user-name"];
    delete headers["tailscale-user-profile-pic"];
    delete headers["tailscale-app-capabilities"];

    const upstream = request({
      hostname: "127.0.0.1",
      port: dashboardPort,
      method: incoming.method,
      path: incoming.url,
      headers
    }, (response) => {
      outgoing.writeHead(response.statusCode || 502, {
        ...response.headers,
        "Permissions-Policy": "camera=(), microphone=(self)"
      });
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

function tailscaleCandidates(env = process.env, platform = process.platform) {
  const values = [
    env.RIOS_TAILSCALE_PATH,
    platform === "darwin" ? "/usr/local/bin/tailscale" : "",
    platform === "darwin" ? "/opt/homebrew/bin/tailscale" : "",
    platform === "win32" ? "tailscale.exe" : "tailscale"
  ].filter(Boolean);
  return values.filter((value, index) => values.indexOf(value) === index);
}

function runTailscale(command, args, run = spawnSync) {
  const result = run(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000
  });
  return {
    error: result.error,
    status: result.status,
    stderr: String(result.stderr || "").trim(),
    stdout: String(result.stdout || "").trim()
  };
}

function parseJsonOutput(result) {
  if (result.error || result.status !== 0 || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function tailscalePhoneHost(status) {
  if (
    status?.BackendState !== "Running"
    || status?.Self?.Online !== true
    || status?.CurrentTailnet?.MagicDNSEnabled !== true
  ) {
    return "";
  }
  const capabilities = Array.isArray(status.Self.Capabilities) ? status.Self.Capabilities : [];
  if (!capabilities.includes("https")) return "";
  const hostname = String(status.Self.DNSName || "").replace(/\.$/, "").toLowerCase();
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/.test(hostname) ? hostname : "";
}

function occupiedServePorts(configuration) {
  const ports = new Set();
  for (const port of Object.keys(configuration?.TCP || {})) {
    const parsed = Number.parseInt(port, 10);
    if (Number.isInteger(parsed)) ports.add(parsed);
  }
  return ports;
}

function matchingServePort(configuration, target) {
  for (const [origin, entry] of Object.entries(configuration?.Web || {})) {
    const handlers = entry?.Handlers || {};
    if (!Object.values(handlers).some((handler) => handler?.Proxy === target)) continue;
    try {
      const parsed = new URL(`https://${origin}`);
      const port = Number.parseInt(parsed.port || "443", 10);
      if (Number.isInteger(port)) return port;
    } catch {}
  }
  return null;
}

function availableServePort(configuration, preferredPort = DEFAULT_SECURE_PHONE_PORT) {
  const occupied = occupiedServePorts(configuration);
  for (let port = preferredPort; port < preferredPort + SECURE_PHONE_PORT_ATTEMPTS; port += 1) {
    if (!occupied.has(port)) return port;
  }
  return null;
}

function findTailscale(run = spawnSync, env = process.env, platform = process.platform) {
  for (const command of tailscaleCandidates(env, platform)) {
    const result = runTailscale(command, ["status", "--json"], run);
    const status = parseJsonOutput(result);
    if (status) return { command, status };
  }
  return null;
}

function startSecurePhoneAccess({
  proxyPort,
  token,
  preferredPort = DEFAULT_SECURE_PHONE_PORT,
  run = spawnSync,
  env = process.env,
  platform = process.platform
}) {
  const tailscale = findTailscale(run, env, platform);
  if (!tailscale) return { available: false, reason: "tailscale-unavailable" };
  const hostname = tailscalePhoneHost(tailscale.status);
  if (!hostname) return { available: false, reason: "tailscale-https-unavailable" };

  const target = `http://127.0.0.1:${proxyPort}`;
  const serveResult = runTailscale(tailscale.command, ["serve", "status", "--json"], run);
  const configuration = parseJsonOutput(serveResult) || {};
  const existingPort = matchingServePort(configuration, target);
  const port = existingPort ?? availableServePort(configuration, preferredPort);
  if (!port) return { available: false, reason: "tailscale-ports-in-use" };

  if (!existingPort) {
    const configured = runTailscale(
      tailscale.command,
      ["serve", "--bg", "--yes", `--https=${port}`, target],
      run
    );
    if (configured.error || configured.status !== 0) {
      return {
        available: false,
        reason: "tailscale-serve-failed",
        detail: configured.stderr || configured.stdout
      };
    }
  }

  return {
    available: true,
    command: tailscale.command,
    hostname,
    port,
    target,
    url: phoneAccessUrl(hostname, port, token, "https")
  };
}

function stopSecurePhoneAccess(access, run = spawnSync) {
  if (!access?.available || !access.command || !access.port) return;
  runTailscale(access.command, ["serve", `--https=${access.port}`, "off"], run);
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
  host = "127.0.0.1",
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
  DEFAULT_SECURE_PHONE_PORT,
  availableServePort,
  createAccessToken,
  findTailscale,
  isPrivateIpv4,
  isValidAccessToken,
  lanIpv4Addresses,
  matchingServePort,
  phoneAccessUrl,
  rotateAccessToken,
  startSecurePhoneAccess,
  startPhoneAccessProxy,
  stopSecurePhoneAccess,
  stopPhoneAccessProxy,
  tailscalePhoneHost,
  tokensMatch
};
