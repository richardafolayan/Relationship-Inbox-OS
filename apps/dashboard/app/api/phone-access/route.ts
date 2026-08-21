import { networkInterfaces } from "node:os";
import QRCode from "qrcode";
import { buildPhoneAccessUrl, securePhoneAccessUrl } from "@/lib/phone-access-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const token = process.env.RIOS_PHONE_ACCESS_TOKEN || "";
  const fallbackUrl = process.env.RIOS_ALLOW_INSECURE_PHONE_ACCESS === "1"
    ? buildPhoneAccessUrl(networkInterfaces(), process.env.RIOS_PHONE_ACCESS_PORT || "", token)
    : null;
  const secureUrl = securePhoneAccessUrl(
    process.env.RIOS_PHONE_ACCESS_SECURE_URL || "",
    token
  );
  const url = secureUrl || fallbackUrl;
  if (!url) {
    return Response.json(
      { available: false, reason: "secure-phone-access-required" },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 2, width: 320 });
  return Response.json(
    {
      available: true,
      dictationReady: Boolean(secureUrl),
      fallbackUrl: secureUrl ? fallbackUrl : undefined,
      secure: Boolean(secureUrl),
      url,
      qrDataUrl
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
