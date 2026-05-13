import type { NextRequest } from "next/server";

export const runtime = "nodejs";

function buildRunnerEventsUrl(request: NextRequest): string {
  const base = process.env.RUNNER_ORIGIN ?? "http://localhost:4001";
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

  // Forward the client's abort signal so when the dashboard tab closes or
  // navigates, the upstream runner fetch is cancelled too — otherwise the
  // proxy keeps draining SSE forever after the client is gone.
  let response: Response;
  try {
    response = await fetch(targetUrl, {
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...(lastEventId ? { "Last-Event-ID": lastEventId } : {})
      },
      signal: request.signal
    });
  } catch (error) {
    // AbortError surfaces when the client disconnected — return 499 so the
    // (already gone) client doesn't misread a partial response as 200.
    // Network / DNS errors return 502 instead.
    const aborted = error instanceof Error && error.name === "AbortError";
    return new Response(aborted ? "client disconnected" : "runner unreachable", {
      status: aborted ? 499 : 502
    });
  }

  // Non-2xx upstream must not be re-framed as a successful SSE stream.
  // EventSource would receive a JSON error body labelled as
  // `text/event-stream` and silently fail to parse, leaving the dashboard
  // wondering why no events ever arrive. Surface the upstream status so the
  // EventSource onerror handler runs and the dashboard's health poll can
  // notice the runner is down.
  if (!response.ok) {
    return new Response(`runner /events returned ${response.status}`, {
      status: response.status === 401 ? 401 : 502
    });
  }

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
