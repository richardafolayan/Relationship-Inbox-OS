import { networkInterfaces } from "node:os";
import QRCode from "qrcode";
import { buildPhoneAccessUrl } from "@/lib/phone-access-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const url = buildPhoneAccessUrl(
    networkInterfaces(),
    process.env.RIOS_PHONE_ACCESS_PORT || "",
    process.env.RIOS_PHONE_ACCESS_TOKEN || ""
  );
  if (!url) {
    return Response.json(
      { available: false },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 2, width: 320 });
  return Response.json(
    { available: true, url, qrDataUrl },
    { headers: { "Cache-Control": "no-store" } }
  );
}
