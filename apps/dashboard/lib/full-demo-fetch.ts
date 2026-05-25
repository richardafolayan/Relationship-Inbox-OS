/**
 * Live-mode read-only enforcement.
 *
 * When the full-presenter-demo is running in "live" mode, the dashboard
 * monkey-patches `window.fetch` so any mutation request to the runner's
 * `/control/...` paths is intercepted client-side: it never leaves the
 * browser, the server is the second line of defence via the
 * presenter-guard middleware.
 *
 * The patch is installed via `installLiveDemoFetchInterceptor()` and
 * torn down via the returned function. FullDemoProvider owns the
 * lifecycle — it must call the teardown on exit so normal app behaviour
 * is restored.
 */

export type InterceptToast = (message: string) => void;

/**
 * Path-matchers for mutation endpoints to intercept in live mode. Order
 * matters: more specific paths come first. Each pair is [matcher, verb]
 * where `verb` is the human-readable action surfaced in the toast.
 *
 * NEVER intercepted:
 *   - GET requests (reads are always safe).
 *   - POST /control/settings (exit path).
 *   - POST /control/presenter-demo/reset (exit path).
 */
export const LIVE_INTERCEPTED_PATHS: Array<[RegExp, string]> = [
  [/\/control\/thread\/[^/]+\/send$/, "send a message"],
  [/\/control\/thread\/[^/]+\/cancel-send$/, "cancel a send"],
  [/\/control\/thread\/[^/]+\/update-send$/, "update a scheduled send"],
  [/\/control\/thread\/[^/]+\/retry-send$/, "retry a send"],
  [/\/control\/thread\/[^/]+\/draft$/, "save a draft"],
  [/\/control\/thread\/[^/]+\/predraft$/, "request an AI predraft"],
  [/\/control\/thread\/[^/]+\/check-draft$/, "check draft coverage"],
  [/\/control\/thread\/[^/]+\/voice-rewrite$/, "voice-rewrite a draft"],
  [/\/control\/thread\/[^/]+\/transform$/, "transform a draft"],
  [/\/control\/thread\/[^/]+\/compose$/, "compose a reply"],
  [/\/control\/thread\/[^/]+\/reassess$/, "reassess the thread"],
  [/\/control\/thread\/[^/]+\/snooze$/, "snooze the thread"],
  [/\/control\/thread\/[^/]+\/unsnooze$/, "unsnooze the thread"],
  [/\/control\/thread\/[^/]+\/archive$/, "archive the thread"],
  [/\/control\/thread\/[^/]+\/unarchive$/, "unarchive the thread"],
  [/\/control\/thread\/[^/]+\/mark-done$/, "mark the thread handled"],
  [/\/control\/thread\/[^/]+\/open-loop$/, "edit the reply checklist"],
  [/\/control\/thread\/[^/]+\/rescan$/, "rescan the thread"],
  [/\/control\/person\/[^/]+\/rename$/, "rename the contact"],
  [/\/control\/person\/[^/]+\/notes$/, "save contact notes"],
  [/\/control\/person\/[^/]+\/profile-url$/, "set the contact profile URL"],
  [/\/control\/person\/[^/]+\/enrich$/, "enrich the contact"],
  [/\/control\/person\/[^/]+\/friendship-summary$/, "summarise the friendship"],
  [/\/control\/person\/[^/]+\/ask$/, "ask about the contact"],
  [/\/control\/closed-status\/refresh-stale$/, "refresh closed verdicts"],
  [/\/control\/reconnect\/refresh-scores$/, "refresh reconnect scores"],
  [/\/control\/platform\/connect$/, "connect a platform"],
  [/\/control\/platform\/test-selectors$/, "run selector tests"],
  [/\/control\/platform\/open-browser$/, "open the platform browser"],
  [/\/control\/platform\/linkedin\/smoke-unread$/, "run a LinkedIn smoke test"],
  [/\/control\/platform\/reset-session$/, "reset the platform session"],
  [/\/control\/people\/scan-all$/, "scan all people"],
  [/\/control\/scan$/, "run a scan"],
  [/\/control\/operator-profile$/, "save your profile"]
];

/**
 * Always-allowed mutation paths (exit / safety paths). Matched BEFORE the
 * intercept list so even in live mode they pass through.
 */
export const LIVE_ALLOWED_MUTATION_PATHS: RegExp[] = [
  /\/control\/settings$/,
  /\/control\/presenter-demo\/reset$/,
  /\/control\/scan\/abort$/,
  /\/control\/pilot-feedback$/
];

export function describeInterceptedAction(url: string): string | null {
  for (const [matcher, verb] of LIVE_INTERCEPTED_PATHS) {
    if (matcher.test(url)) return verb;
  }
  return null;
}

export function isExitPath(url: string): boolean {
  return LIVE_ALLOWED_MUTATION_PATHS.some((m) => m.test(url));
}

export function shouldInterceptLive(method: string, url: string): boolean {
  if (method.toUpperCase() === "GET") return false;
  if (isExitPath(url)) return false;
  return describeInterceptedAction(url) !== null;
}

function urlFromInput(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

function methodFromInit(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method;
  if (input instanceof Request) return input.method;
  return "GET";
}

interface InstallOpts {
  /** Toast hook — called with a human-readable description of the blocked action. */
  onIntercept: InterceptToast;
}

/**
 * Installs a `window.fetch` patch that intercepts mutation requests while
 * live presenter demo mode is active. Returns a teardown function.
 *
 * Safe to call twice — the second install is a no-op until teardown.
 */
export function installLiveDemoFetchInterceptor(opts: InstallOpts): () => void {
  if (typeof window === "undefined") return () => undefined;
  const original = window.fetch;
  if ((window.fetch as unknown as { __fullDemoInstalled?: boolean }).__fullDemoInstalled) {
    return () => undefined;
  }

  const wrapped = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = urlFromInput(input);
    const method = methodFromInit(input, init);
    if (shouldInterceptLive(method, url)) {
      const verb = describeInterceptedAction(url) ?? "make a change";
      opts.onIntercept(`Live demo is read-only. This would ${verb} in normal use.`);
      return new Response(
        JSON.stringify({ ok: true, intercepted: true, action: verb }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return original.call(window, input, init);
  } as typeof window.fetch;

  (wrapped as unknown as { __fullDemoInstalled?: boolean }).__fullDemoInstalled = true;
  window.fetch = wrapped;
  return () => {
    if (window.fetch === wrapped) {
      window.fetch = original;
    }
  };
}
