# @numoteq/analytics-kit

## 1.2.2

### Patch Changes

- b28fe13: Drop the leftovers of several upstreams: the `PREFIX`, `PREFIXES` and `UpstreamName` exports are removed (use `SGTM_PREFIX`), and the proxy keeps one optional sGTM client instead of a map of upstreams. Behaviour is unchanged.

## 1.2.1

### Patch Changes

- f2bfb3e: Remove the `apiSecret` and `apiSecretVar` options: server events go to our sGTM, which forwards them to GA4 like browser hits and never needs Google's Measurement Protocol `api_secret`.

## 1.2.0

### Minor Changes

- 31910c0: Server events no longer carry GA4 settings: the `measurementId` and `measurementIdVar` options, `session_id` and `measurement_id` in the hit, and the `sessionIdOf` export are removed. The sender instead forwards the visitor's consented analytics cookies (`_ga`, `_ga_*`, … with `measurement`, ad cookies with `marketing`) and the `x-forwarded-for` and `user-agent` headers, so the server container reads the session and the destinations are configured there alone. The send timeout now also covers reading the body of a refused hit, and `GtmScriptOptions` no longer offers `dataLayer`, which the loader would not follow.

## 1.1.0

### Minor Changes

- 4b36a26: Remove the browser OpenPanel upstream and session-replay transport: `OPENPANEL_UPSTREAM`, the `openpanel` and `openpanelBinding` options, `OPENPANEL_PREFIX`, `/_op`, and plain SDK script serving. OpenPanel remains a destination through sGTM; the sGTM proxy and server events are unchanged.

## 1.0.0

### Major Changes

- First release. Succeeds `@numoteq/sgtm-proxy`: the same first-party proxy now routes `/_sgtm` to sGTM and `/_op` to OpenPanel, forwards every header including `cf-*`, keeps the analytics cookie allowlist for sGTM, sends no cookies to OpenPanel, and gives OpenPanel the visitor's address in `openpanel-client-ip`.
- `@numoteq/analytics-kit/server`: server-originated events through the Measurement Protocol client of our sGTM, enriched with the visitor's IP, user agent and page, the `_ga` client id and the `_ga_<id>` session id of the configured measurement id, `_fbp`/`_fbc`, and SHA-256 hashed e-mail and phone. Identifiers travel only with the consent they belong to (analytics storage for the GA cookies, marketing for the Meta ones and the hashes); the IP, the user agent and the page stay the open part of the hit. Consent goes as `gcs`. Sent once, never retried.
- `@numoteq/analytics-kit/astro`: the `analytics()` integration, which serves the proxy and sets `locals.analytics.event()`.
- `createAnalytics()` builds the proxy and the sender on one runtime, which is what the integration uses; `createProxyHandler()` and `createServerEvents()` are the same parts on their own.
- `@numoteq/analytics-kit/c15t`: `c15tPreset()` and `gtmScripts()`, the container script that loads through the proxy with the shim in front.
- `@numoteq/analytics-kit/client`: `loaderPath(host)` and the prefix constants, with no dependencies.
