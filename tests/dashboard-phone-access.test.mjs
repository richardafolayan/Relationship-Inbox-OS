import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPhoneAccessUrl,
  isPrivateIpv4,
  privateAddresses,
  securePhoneAccessUrl
} from "../apps/dashboard/lib/phone-access-server.ts";

const interfaces = {
  bridge0: [{ address: "192.168.64.1", family: "IPv4", internal: false, cidr: null, mac: "", netmask: "" }],
  en0: [{ address: "192.168.1.4", family: "IPv4", internal: false, cidr: null, mac: "", netmask: "" }],
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true, cidr: null, mac: "", netmask: "" }]
};

test("phone access recognises private IPv4 ranges only", () => {
  assert.equal(isPrivateIpv4("192.168.1.4"), true);
  assert.equal(isPrivateIpv4("172.20.0.1"), true);
  assert.equal(isPrivateIpv4("10.0.0.8"), true);
  assert.equal(isPrivateIpv4("8.8.8.8"), false);
  assert.equal(isPrivateIpv4("127.0.0.1"), false);
});

test("phone access prefers the primary Wi-Fi adapter", () => {
  assert.deepEqual(privateAddresses(interfaces), ["192.168.1.4", "192.168.64.1"]);
});

test("phone access builds a pairing link only from valid launcher state", () => {
  const token = "a".repeat(43);
  assert.equal(
    buildPhoneAccessUrl(interfaces, "3110", token),
    `http://192.168.1.4:3110/connect/${token}`
  );
  assert.equal(buildPhoneAccessUrl(interfaces, "0", token), null);
  assert.equal(buildPhoneAccessUrl(interfaces, "3110", "too-short"), null);
  assert.equal(buildPhoneAccessUrl({}, "3110", token), null);
});

test("secure phone access accepts only the launcher token on a Tailscale HTTPS origin", () => {
  const token = "a".repeat(43);
  assert.equal(
    securePhoneAccessUrl(`https://tovi-mac.tail1234.ts.net:3111/connect/${token}`, token),
    `https://tovi-mac.tail1234.ts.net:3111/connect/${token}`
  );
  assert.equal(
    securePhoneAccessUrl(`http://tovi-mac.tail1234.ts.net:3111/connect/${token}`, token),
    null
  );
  assert.equal(
    securePhoneAccessUrl(`https://evil.example/connect/${token}`, token),
    null
  );
  assert.equal(
    securePhoneAccessUrl(`https://tovi-mac.tail1234.ts.net:3111/connect/${"b".repeat(43)}`, token),
    null
  );
});
