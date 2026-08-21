import { networkInterfaces } from "node:os";
import QRCode from "qrcode";
import { buildPhoneAccessUrl, securePhoneAccessUrl } from "@/lib/phone-access-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character] ?? character);
}

export async function GET(request: Request): Promise<Response> {
  const token = process.env.RIOS_PHONE_ACCESS_TOKEN || "";
  const secureUrl = securePhoneAccessUrl(process.env.RIOS_PHONE_ACCESS_SECURE_URL || "", token);
  const fallbackUrl = process.env.RIOS_ALLOW_INSECURE_PHONE_ACCESS === "1"
    ? buildPhoneAccessUrl(networkInterfaces(), process.env.RIOS_PHONE_ACCESS_PORT || "", token)
    : null;
  const connectUrl = secureUrl || fallbackUrl;
  const threadId = new URL(request.url).searchParams.get("threadId") || "";
  if (!connectUrl || !/^[A-Za-z0-9_-]+$/.test(threadId)) {
    return new Response("Diagnostics handoff unavailable.", { status: 400 });
  }

  const phoneOrigin = new URL(connectUrl).origin;
  const testUrl = `${phoneOrigin}/thread/${threadId}?viewportDiagnostics=1`;
  const [connectQr, testQr] = await Promise.all([
    QRCode.toDataURL(connectUrl, { margin: 2, width: 360 }),
    QRCode.toDataURL(testUrl, { margin: 2, width: 360 })
  ]);
  const html = `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Tovi viewport diagnostics</title>
    <style>
      body { margin: 0; background: #111; color: #f7f2e8; font: 16px -apple-system, BlinkMacSystemFont, sans-serif; }
      main { display: grid; grid-template-columns: repeat(2, minmax(280px, 1fr)); gap: 28px; max-width: 900px; margin: 0 auto; padding: 32px; }
      section { background: #1c1c1c; border-radius: 18px; padding: 24px; text-align: center; }
      img { display: block; width: min(100%, 360px); margin: 20px auto 0; border-radius: 12px; }
      p { color: #c8c0b4; line-height: 1.45; }
      code { color: #f7f2e8; }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>1. Connect</h1>
        <p>Scan once in Safari to establish protected phone access.</p>
        <img src="${escapeHtml(connectQr)}" alt="Protected Tovi connection QR">
      </section>
      <section>
        <h1>2. Open diagnostics</h1>
        <p>Return to Camera and scan this code. A small <code>Viewport log</code> badge confirms capture.</p>
        <img src="${escapeHtml(testQr)}" alt="Tovi viewport diagnostics QR">
      </section>
    </main>
  </body>
</html>`;
  return new Response(html, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8"
    }
  });
}
