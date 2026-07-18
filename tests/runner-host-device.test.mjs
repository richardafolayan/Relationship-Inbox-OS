import test from "node:test";
import assert from "node:assert/strict";

const {
  fallbackHostLabel,
  hostDeviceKind,
  resolveHostDeviceInfo
} = await import("../apps/runner/src/services/host-device.ts");

test("hostDeviceKind maps platforms to calm device kinds", () => {
  assert.equal(hostDeviceKind("darwin"), "mac");
  assert.equal(hostDeviceKind("win32"), "pc");
  assert.equal(hostDeviceKind("linux"), "computer");
});

test("fallbackHostLabel matches the device kind", () => {
  assert.equal(fallbackHostLabel("mac"), "your Mac");
  assert.equal(fallbackHostLabel("pc"), "this PC");
  assert.equal(fallbackHostLabel("computer"), "this computer");
});

test("resolveHostDeviceInfo prefers the macOS ComputerName", () => {
  const info = resolveHostDeviceInfo({
    platform: "darwin",
    computerName: "Richard's MacBook",
    hostName: "Mac.home"
  });
  assert.equal(info.label, "Richard's MacBook");
  assert.equal(info.kind, "mac");
  assert.equal(info.platform, "darwin");
  assert.equal(info.hostname, "Mac.home");
});

test("resolveHostDeviceInfo falls back to a non-generic hostname", () => {
  const info = resolveHostDeviceInfo({
    platform: "darwin",
    computerName: null,
    hostName: "office-macbook.local"
  });
  assert.equal(info.label, "office-macbook");
  assert.equal(info.kind, "mac");
  assert.equal(info.hostname, "office-macbook.local");
});

test("resolveHostDeviceInfo ignores generic hostnames", () => {
  const info = resolveHostDeviceInfo({
    platform: "darwin",
    computerName: null,
    hostName: "Mac.home"
  });
  assert.equal(info.label, "your Mac");
});

test("resolveHostDeviceInfo uses PC wording on Windows", () => {
  const info = resolveHostDeviceInfo({
    platform: "win32",
    computerName: null,
    hostName: "localhost"
  });
  assert.equal(info.label, "this PC");
  assert.equal(info.kind, "pc");
});
