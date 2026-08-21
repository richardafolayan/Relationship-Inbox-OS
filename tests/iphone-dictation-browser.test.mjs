import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "patchright";

const require = createRequire(import.meta.url);
const phoneAccess = require("../apps/desktop/phone-access.cjs");
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const LOCAL_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolveClose) => server.close(resolveClose));
}

async function browserBundle() {
  const result = await build({
    bundle: true,
    format: "iife",
    platform: "browser",
    stdin: {
      contents: `
        import {
          dictationCaptureAvailability,
          dictationCaptureRecoveryMessage,
          startDictationCapture
        } from "./apps/dashboard/lib/dictation-capture.ts";
        import { prepareDictationAudio } from "./apps/dashboard/lib/dictation-recording.ts";

        const dictate = document.querySelector("#dictate");
        const cancel = document.querySelector("#cancel");
        const status = document.querySelector("#status");
        let session = null;
        let uploadCount = 0;

        const availability = dictationCaptureAvailability({
          isSecureContext: window.isSecureContext,
          mediaDevices: navigator.mediaDevices,
          MediaRecorderClass: window.MediaRecorder
        });
        dictate.textContent = availability.available ? "Dictate" : "Dictation unavailable";
        dictate.disabled = !availability.available;
        document.querySelector("#recovery").textContent = availability.available
          ? ""
          : dictationCaptureRecoveryMessage(availability.reason);

        async function start() {
          if (session) {
            status.textContent = "transcribing";
            session.stop();
            session = null;
            return;
          }
          session = await startDictationCapture({
            onCancel() {
              document.body.dataset.trackStates =
                window.activeStream?.getTracks().map((track) => track.readyState).join(",") || "";
              status.textContent = "cancelled";
            },
            onError(error) {
              status.textContent = "error:" + (error?.name || "unknown");
            },
            async onRecorded(blob) {
              document.body.dataset.trackStates =
                window.activeStream?.getTracks().map((track) => track.readyState).join(",") || "";
              const prepared = await prepareDictationAudio({ blob, uploadMode: "wav" });
              const form = new FormData();
              form.append("audio", prepared.blob, prepared.filename);
              const response = await fetch("/runner/control/transcribe-dictation", {
                method: "POST",
                body: form
              });
              const data = await response.json();
              uploadCount += 1;
              document.querySelector("#raw").value = data.text;
              document.querySelector("#review").hidden = false;
              status.textContent = "review";
            }
          });
          window.activeStream = session.stream;
          status.textContent = "recording";
        }

        dictate.addEventListener("click", start);
        cancel.addEventListener("click", () => {
          session?.cancel();
          session = null;
        });
        document.querySelector("#keep").addEventListener("click", () => {
          document.querySelector("#composer").value = document.querySelector("#raw").value;
        });
        document.querySelector("#format").addEventListener("click", () => {
          const value = document.querySelector("#raw").value;
          document.querySelector("#messages").innerHTML =
            '<textarea aria-label="Message 1"></textarea><textarea aria-label="Message 2"></textarea>';
          const fields = document.querySelectorAll("#messages textarea");
          fields[0].value = value;
          fields[1].value = "Second message";
        });
        window.addEventListener("pagehide", () => {
          session?.cancel();
          session = null;
        });
      `,
      resolveDir: ROOT,
      sourcefile: "iphone-dictation-harness.ts"
    },
    write: false
  });
  return result.outputFiles[0].text;
}

test("phone-sized secure browser records, uploads through the token proxy, and never autosends", async () => {
  const temp = mkdtempSync(join(tmpdir(), "tovi-secure-dictation-"));
  const keyPath = join(temp, "key.pem");
  const certPath = join(temp, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath,
    "-out", certPath,
    "-subj", "/CN=tovi.test",
    "-addext", "subjectAltName=DNS:tovi.test",
    "-days", "1"
  ], { stdio: "ignore" });

  const bundle = await browserBundle();
  const uploads = [];
  let sendRequests = 0;
  const dashboard = createHttpServer((incoming, outgoing) => {
    if (incoming.method === "POST" && incoming.url === "/runner/control/transcribe-dictation") {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => {
        uploads.push({
          body: Buffer.concat(chunks),
          contentType: incoming.headers["content-type"],
          forwardedFor: incoming.headers["x-forwarded-for"]
        });
        outgoing.writeHead(200, { "Content-Type": "application/json" });
        outgoing.end(JSON.stringify({ ok: true, text: "Known sentence from iPhone" }));
      });
      return;
    }
    if (incoming.method === "POST" && incoming.url?.includes("/send")) {
      sendRequests += 1;
      outgoing.writeHead(500).end();
      return;
    }
    outgoing.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    outgoing.end(`<!doctype html>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <button id="dictate"></button><button id="cancel">Cancel</button>
      <p id="status"></p><p id="recovery"></p>
      <section id="review" hidden>
        <textarea id="raw" aria-label="Raw transcript"></textarea>
        <button id="keep">Keep as transcript</button>
        <button id="format">Turn into messages</button>
        <div id="messages"></div>
      </section>
      <textarea id="composer" aria-label="Composer"></textarea>
      <script>${bundle}</script>`);
  });
  const dashboardPort = await listen(dashboard);
  const token = phoneAccess.createAccessToken();
  const proxy = await phoneAccess.startPhoneAccessProxy({
    allowInsecure: true,
    dashboardPort,
    host: "127.0.0.1",
    preferredPort: 0,
    token
  });
  const tls = createHttpsServer(
    { cert: readFileSync(certPath), key: readFileSync(keyPath) },
    (incoming, outgoing) => {
      const upstream = httpRequest({
        headers: { ...incoming.headers, "x-forwarded-proto": "https" },
        hostname: "127.0.0.1",
        method: incoming.method,
        path: incoming.url,
        port: proxy.port
      }, (response) => {
        outgoing.writeHead(response.statusCode || 502, response.headers);
        response.pipe(outgoing);
      });
      incoming.pipe(upstream);
    }
  );
  const tlsPort = await listen(tls);
  const browser = await chromium.launch({
    ...(existsSync(LOCAL_CHROME) ? { executablePath: LOCAL_CHROME } : {}),
    headless: true,
    args: [
      "--host-resolver-rules=MAP tovi.test 127.0.0.1",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream"
    ]
  });

  try {
    const context = await browser.newContext({
      hasTouch: true,
      ignoreHTTPSErrors: true,
      isMobile: true,
      viewport: { width: 390, height: 844 }
    });
    await context.grantPermissions(["microphone"], {
      origin: `https://tovi.test:${tlsPort}`
    });
    const page = await context.newPage();
    await page.goto(`https://tovi.test:${tlsPort}/connect/${token}`);
    await page.getByRole("button", { name: "Dictate", exact: true }).click();
    await page.getByText("recording", { exact: true }).waitFor();
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "Dictate", exact: true }).click();
    await page.getByText("review", { exact: true }).waitFor();

    assert.equal(uploads.length, 1);
    assert.match(uploads[0].contentType, /^multipart\/form-data; boundary=/);
    assert.match(uploads[0].body.toString("latin1"), /filename="dictation\.wav"/);
    assert.match(uploads[0].body.toString("latin1"), /Content-Type: audio\/wav/);
    assert.equal(uploads[0].forwardedFor, "127.0.0.1");
    assert.equal(await page.locator("body").getAttribute("data-track-states"), "ended");

    const raw = page.getByRole("textbox", { name: "Raw transcript" });
    await raw.fill("Edited known sentence");
    await page.getByRole("button", { name: "Keep as transcript" }).click();
    assert.equal(await page.getByRole("textbox", { name: "Composer" }).inputValue(), "Edited known sentence");
    await page.getByRole("button", { name: "Turn into messages" }).click();
    await page.getByRole("textbox", { name: "Message 1" }).fill("Edited first message");
    assert.equal(await page.getByRole("textbox", { name: "Message 1" }).inputValue(), "Edited first message");
    assert.equal(sendRequests, 0);

    await page.getByRole("button", { name: "Dictate", exact: true }).click();
    await page.getByText("recording", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByText("cancelled", { exact: true }).waitFor();
    assert.equal(await page.locator("body").getAttribute("data-track-states"), "ended");
    assert.equal(uploads.length, 1);
    await context.close();

    const insecureContext = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 }
    });
    const insecurePage = await insecureContext.newPage();
    await insecurePage.goto(`http://tovi.test:${proxy.port}/connect/${token}`);
    const unavailable = insecurePage.getByRole("button", { name: "Dictation unavailable" });
    assert.equal(await unavailable.isDisabled(), true);
    await insecurePage.getByText(/scan the HTTPS QR code/).waitFor();
    await insecureContext.close();
  } finally {
    await browser.close();
    await close(tls);
    await phoneAccess.stopPhoneAccessProxy(proxy.server);
    await close(dashboard);
    rmSync(temp, { recursive: true, force: true });
  }
});
