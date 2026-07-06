import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeRequestTarget,
  isPrivateAddress,
  normalizeRequestedUrl
} from "../apps/runner/dist/services/link-preview.js";

// The link-preview endpoint fetches URLs that came out of a CONTACT'S
// message - hostile input by definition. These tests pin the SSRF guard:
// nothing private, loopback, link-local, or otherwise internal may ever
// be fetched, no matter how the URL is dressed up.

const PUBLIC_V4 = ["8.8.8.8", "142.250.187.206", "104.16.132.229", "1.1.1.1"];
const PRIVATE_V4 = [
  "0.0.0.0",
  "10.0.0.1",
  "10.255.255.255",
  "100.64.0.1", // CGNAT
  "100.127.255.254",
  "127.0.0.1",
  "127.1.2.3",
  "169.254.169.254", // cloud metadata
  "172.16.0.1",
  "172.31.255.255",
  "192.0.0.1",
  "192.0.2.10", // TEST-NET-1
  "192.168.1.1",
  "198.18.0.1", // benchmarking
  "198.51.100.7", // TEST-NET-2
  "203.0.113.9", // TEST-NET-3
  "224.0.0.1", // multicast
  "255.255.255.255"
];
const PRIVATE_V6 = ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%en0", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:10.0.0.5"];
const PUBLIC_V6 = ["2606:4700:4700::1111", "2a00:1450:4009:81f::200e", "::ffff:8.8.8.8"];

test("isPrivateAddress: private/reserved IPv4 ranges are flagged", () => {
  for (const ip of PRIVATE_V4) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test("isPrivateAddress: public IPv4 addresses pass", () => {
  for (const ip of PUBLIC_V4) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test("isPrivateAddress: private/reserved IPv6 ranges are flagged", () => {
  for (const ip of PRIVATE_V6) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test("isPrivateAddress: public IPv6 addresses pass", () => {
  for (const ip of PUBLIC_V6) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test("isPrivateAddress: non-IP input is treated as unsafe", () => {
  assert.equal(isPrivateAddress("not-an-ip"), true);
  assert.equal(isPrivateAddress(""), true);
});

const resolveTo = (...addresses) => async () => addresses;
const neverResolve = async () => {
  throw new Error("ENOTFOUND");
};

async function assertBlocked(url, resolver, label) {
  await assert.rejects(
    () => assertSafeRequestTarget(new URL(url), resolver ?? resolveTo("8.8.8.8")),
    undefined,
    label ?? `${url} should be blocked`
  );
}

test("assertSafeRequestTarget: only http/https schemes are allowed", async () => {
  await assertBlocked("ftp://example.com/file");
  await assertBlocked("file:///etc/passwd");
  // javascript:/data: don't even parse into a fetchable target, but make
  // sure nothing upstream of the guard would accept them either.
  assert.equal(normalizeRequestedUrl("javascript:alert(1)"), null);
  assert.equal(normalizeRequestedUrl("data:text/html,hi"), null);
});

test("assertSafeRequestTarget: credentials in the URL are rejected", async () => {
  await assertBlocked("https://user:pass@example.com/");
  await assertBlocked("https://admin@example.com/");
});

test("assertSafeRequestTarget: localhost and internal-suffix hostnames are blocked", async () => {
  for (const url of [
    "http://localhost/",
    "http://localhost:4001/data/inbox",
    "http://LOCALHOST./",
    "http://foo.localhost/",
    "http://printer.local/",
    "http://db.internal/",
    "http://router.lan/",
    "http://nas.home.arpa/"
  ]) {
    await assertBlocked(url);
  }
});

test("assertSafeRequestTarget: private IP literals are blocked without resolving", async () => {
  for (const ip of PRIVATE_V4) {
    await assertBlocked(`http://${ip}/`, neverResolve);
  }
  await assertBlocked("http://[::1]/", neverResolve);
  await assertBlocked("http://[fe80::1]/", neverResolve);
  await assertBlocked("http://[::ffff:192.168.0.1]/", neverResolve);
});

test("assertSafeRequestTarget: hostnames resolving to private addresses are blocked", async () => {
  await assertBlocked("https://rebind.example.com/", resolveTo("127.0.0.1"));
  await assertBlocked("https://rebind.example.com/", resolveTo("10.0.0.8"));
  // One private address among public ones still blocks.
  await assertBlocked("https://rebind.example.com/", resolveTo("8.8.8.8", "192.168.0.10"));
  await assertBlocked("https://rebind.example.com/", resolveTo("2606:4700::1", "fd00::1"));
});

test("assertSafeRequestTarget: unresolvable hosts are blocked", async () => {
  await assertBlocked("https://nope.example.com/", neverResolve);
  await assertBlocked("https://empty.example.com/", resolveTo());
});

test("assertSafeRequestTarget: public hosts pass", async () => {
  await assertSafeRequestTarget(new URL("https://example.com/page"), resolveTo("93.184.216.34"));
  await assertSafeRequestTarget(new URL("http://example.com:8080/x"), resolveTo("93.184.216.34"));
  await assertSafeRequestTarget(new URL("https://8.8.8.8/"), neverResolve);
  await assertSafeRequestTarget(
    new URL("https://dual.example.com/"),
    resolveTo("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946")
  );
});

test("normalizeRequestedUrl: trims, defaults scheme, rejects junk", () => {
  assert.equal(normalizeRequestedUrl("  https://example.com/a  ")?.toString(), "https://example.com/a");
  assert.equal(normalizeRequestedUrl("www.example.com/a")?.toString(), "https://www.example.com/a");
  assert.equal(normalizeRequestedUrl(""), null);
  assert.equal(normalizeRequestedUrl("   "), null);
  assert.equal(normalizeRequestedUrl("not a url at all"), null);
  assert.equal(normalizeRequestedUrl("ftp://example.com"), null);
});
