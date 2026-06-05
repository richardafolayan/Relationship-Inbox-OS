import type { NextRequest } from "next/server";
import { resolveRunnerBase } from "@/lib/runner-base";

export const runtime = "nodejs";

function buildRunnerEventsUrl(request: NextRequest): string {
  const base = resolveRunnerBase();
  const url = new URL("/events", base);

  const since = request.nextUrl.searchParams.get("sinceEventId");
  if (since) {
    url.searchParams.set("sinceEventId", since);
  }

  return url.toString();
}

export async function GET(request: NextRequest): Promise<Response> {
  const targetUrl = buildRunnerEventsUrl(request);
  const lastEventId = request.headers.get("last-event-id");

  const response = await fetch(targetUrl, {
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(lastEventId ? { "Last-Event-ID": lastEventId } : {})
    }
  });

  if (!response.body) {
    return new Response("SSE stream unavailable", { status: 502 });
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    }
  });
}
