# Issue 801 interaction latency report

## Result

The measured high-density Inbox now mounts 80 rows instead of 1,010 and keeps the remaining rows behind an explicit, accessible Show more control. Repeated Inbox responses are serialized and gzipped once per data version instead of once per poll. Inbox content also paints without waiting for platform and audit-log metadata.

The strongest interaction improvements were:

- Search clear: 196.65 ms to 61.04 ms p50, 279.57 ms to 140.48 ms p95.
- Filter clear: 197.38 ms to 56.77 ms p50, 367.04 ms to 145.49 ms p95.
- Select acknowledgement: 176.71 ms to 46.42 ms p50, 227.98 ms to 65.92 ms p95.
- Cached local Inbox API: 389.41 ms to 2.15 ms p50, 2,270.45 ms to 6.28 ms p95.

No claim is made that the whole app, browser rendering, network work, or database work completes below 1 ms. Sub-millisecond results below apply only to suitable direct local operations observed in this fixture.

## Method

- Base: `origin/v1/strip-back-pr1` at `fcf51204a5642e5ca123c075e921e33f5e1ae2d1`.
- Machine: local macOS host, Node.js 20.12.2.
- Data: isolated SQLite fixture at `/tmp/rios-perf.sqlite` with 1,000 generated threads, 20,000 generated messages, plus 11 presenter-demo threads.
- Runtime: built runner, production Next.js dashboard, loopback HTTP.
- External work disabled: iMessage, contacts birthday sync, auto-enrichment and automatic platform scans.
- Samples: process startup 15, HTTP and direct database 50, browser initial render 10, navigation 20, browser interactions 30, cold launcher preparation 5, warm launcher preparation 20.
- Percentiles: nearest-rank p50 and p95 over wall-clock durations from `performance.now()`.
- Browser completion means the expected visible DOM acknowledgement appeared, not merely that a click promise resolved.

The repeatable fixture and measurement entrypoints are:

```bash
DATABASE_URL=file:/tmp/rios-perf.sqlite npm run perf:seed
DATABASE_URL=file:/tmp/rios-perf.sqlite npm run perf:interactions -- \
  --runner http://127.0.0.1:4001 \
  --dashboard http://127.0.0.1:3100 \
  --thread perf-thread-00000 \
  --samples 30 \
  --output /tmp/interaction-latency.json
npm run perf:launcher -- \
  --cold-samples 5 \
  --warm-samples 20 \
  --output /tmp/launcher-latency.json
```

`perf:seed` refuses to run unless `DATABASE_URL` contains `perf` or `benchmark`.

## Browser interactions

| Measurement | Before p50 | Before p95 | After p50 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| Inbox initial render | 316.97 ms | 1,002.19 ms | 166.70 ms | 586.87 ms |
| Inbox to thread | 188.40 ms | 261.97 ms | 148.14 ms | 283.45 ms |
| Search apply | 25.94 ms | 53.39 ms | 12.57 ms | 51.19 ms |
| Search clear | 196.65 ms | 279.57 ms | 61.04 ms | 140.48 ms |
| Filter apply | 93.85 ms | 160.19 ms | 58.09 ms | 136.70 ms |
| Filter clear | 197.38 ms | 367.04 ms | 56.77 ms | 145.49 ms |
| Select visible acknowledgement | 176.71 ms | 227.98 ms | 46.42 ms | 65.92 ms |
| Composer input | 17.19 ms | 74.78 ms | 26.23 ms | 51.70 ms |

Initial Inbox DOM rows fell from 1,010 to 80. Inbox-to-thread p95 increased by 21.48 ms and composer p50 increased by 9.04 ms. Neither code path was changed directly. Their p50 or p95 counterpart improved, so these are retained as known measurement variance rather than hidden.

## Local APIs

| Measurement | Before p50 | Before p95 | After p50 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| Health | 8.41 ms | 34.18 ms | 0.56 ms | 1.54 ms |
| Inbox, cached | 389.41 ms | 2,270.45 ms | 2.15 ms | 6.28 ms |
| Inbox, uncached | 817.70 ms | 2,573.76 ms | 65.16 ms | 82.75 ms |
| Inbox search, uncached | 997.57 ms | 4,039.94 ms | 55.60 ms | 83.85 ms |
| Thread | 77.89 ms | 422.23 ms | 3.16 ms | 4.98 ms |

`X-RIOS-Cache: hit|miss` and `Server-Timing: inbox-prep;dur=...` make the Inbox preparation path observable without logging private response content. Cached responses retain byte-exact JSON semantics and negotiate gzip through normal HTTP headers.

## Direct database calls

| Measurement | Before p50 | Before p95 | After p50 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| Inbox thread projection | 34.67 ms | 204.46 ms | 4.46 ms | 5.94 ms |
| Thread messages, limit 60 | 6.69 ms | 83.35 ms | 0.31 ms | 2.24 ms |
| Sent-today count | 10.51 ms | 54.25 ms | 0.71 ms | 1.16 ms |

No database query was changed. Existing indexes and direct-query p50 results were already suitable; the observed before-and-after movement also reflects host load. The report does not attribute these database changes to this patch.

## Startup

| Measurement | Before p50 | Before p95 | After p50 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| Runner process to health | 930.26 ms | 2,275.09 ms | 302.16 ms | 1,073.33 ms |
| Dashboard process to Inbox HTTP | 1,812.97 ms | 4,476.48 ms | 325.91 ms | 475.81 ms |
| Cold update preparation | 21,564.17 ms | 38,070.82 ms | 51,549.44 ms | 91,342.56 ms |
| Warm unchanged preparation | 100.92 ms | 143.23 ms | 150.35 ms | 303.15 ms |

Launcher code was not changed. Cold preparation intentionally includes Prisma generation, schema push, core build and production dashboard build, so it remains a one-time update path measured in seconds. The slower second cold run occurred under higher host load and is reported as a regression. Normal unchanged preparation remained below 304 ms p95.

## Automated guards

- `tests/dashboard-inbox-pagination.test.mjs` pins the 80-row initial window, page growth, global grouped-section limit and empty behavior.
- `tests/runner-compressed-json-cache.test.mjs` verifies byte-exact JSON round-trip and useful gzip compression.
- Dashboard type-check and runner build cover integration with the large existing pages and route module.

## Scope and risks

- No platform adapter, scan trigger, send propagation path or message watcher changed.
- All matching rows remain loaded, searchable, filterable and selectable. Pagination limits mounted DOM rows, not data availability.
- The UI adds one low-surface-area Show more control rather than a dashboard-style pagination system.
- A very large Inbox still pays the uncached database and shaping cost. The change targets repeated polls and browser render work without changing data semantics.
