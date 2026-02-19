# Verification Checklist

1. Start services and open Platforms page.
2. Click `Run selector tests` on LinkedIn while logged in; confirm it returns `ok:true` and selector rows/screenshot links refresh.
3. Force an auth-required state (LinkedIn logout) and run selector tests; confirm `401` payload with `stage: "auth_check"`, `reason: "login_required"`, and request ID is shown in the inline error panel.
4. Trigger an unread scan while LinkedIn is on the inbox page and confirm the Unread pill (`button[data-test-messaging-inbox-filters__filter-pill="UNREAD"]`) is activated when inactive.
5. Confirm unread scan continues through the transition window (spinner / temporary empty list) and still returns unread candidates after deep container scrolling.
6. Confirm degraded platform card now shows structured failure details (`stage`, `reason`, `requestId`, short summary) instead of only generic `Failed while scanning...`.
7. Open the latest failure artifacts from the card (`screenshot` and `DOM dump`) and verify they match the reported request.
8. In Activity Log / receipts, verify failed scan entries include `stageReceipts`, `runtimeContext`, and `innerError` with stack/cause chain.
9. Open managed browser context and confirm no stray initial `about:blank` tab remains when the page is eligible for reuse.
10. Confirm per-platform tab determinism: opening a second platform does not steal the mapped tab from the first platform.
11. If a forced collect failure is triggered, confirm reason classification is specific (`evaluate_helper_missing`, `evaluate_reference_error`, `timeout`) instead of `unknown`.
12. Trigger repeated LinkedIn scan failures and confirm queue cooldown escalates (`30s -> 60s -> 120s`) with no immediate tight retry loop.
13. Click manual `Run scan` during cooldown and confirm response is non-error blocked status: `Cooling down — next retry in Xs` (not a generic failure).
14. Force a target-closed condition and confirm reason surfaces as `page_closed_mid_stage`, not `thread_list_not_ready` or `unknown`.
