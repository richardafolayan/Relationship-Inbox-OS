import QRCode from "qrcode";
import { securePhoneAccessUrl } from "@/lib/phone-access-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const token = process.env.RIOS_PHONE_ACCESS_TOKEN || "";
  const secureUrl = securePhoneAccessUrl(
    process.env.RIOS_PHONE_ACCESS_SECURE_URL || "",
    token
  );
  const url = secureUrl;
  if (!url) {
    return Response.json(
      { available: false },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 2, width: 320 });
  return Response.json(
    {
      available: true,
      dictationReady: true,
      secure: true,
      url,
      qrDataUrl
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
