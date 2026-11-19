# @numoteq/analytics-kit

## 2.1.1

### Patch Changes

- dc71436: Docs only, no code change: the consent categories are described as the ones our sites configure in c15t, now that the package ships no preset, and the proxy section no longer claims it never re-reads consent (`consentOfHit` reads `gcs` from the hit to expire the cookies the visitor did not allow).

## 2.1.0

### Minor Changes

- 84e5e34: Cookie cleanup reads consent from the hit (`gcs`) instead of parsing c15t's cookie, the preset is gone and the consent configuration belongs to the site, and the browser deletion lists are exported.

## 2.0.0

### Major Changes

- 74a275b: Drop astro 6 support: the `astro` peer range moves from `>=6` to `>=7.4.7`. Two of the advisories this release covers are fixed only in the 7.x line — the string tag name filter (7.4.5) and the `/_image` path check of `@astrojs/node` (7.4.7, GHSA-r3h5-4585-7x3w) — and the astro 6 line ends at 6.4.8, so no 6.x release carries the `/_image` fix. A site on astro 6 now gets a peer conflict instead of an install that keeps a vulnerable astro. Upgrade to astro 7.4.7 or later to use this version; `@astrojs/cloudflare` 13 and 14 stay supported.

## 1.5.0

### Minor Changes

- c3d673a: Forward the cookies Sklik and Google Ads server tags read to sGTM: `sznaiid`, `_dm_session_attributes`, and Seznam's `sid` and `udid` from `sul.js`. `sid` and `udid` pass only in Seznam's value format, so a site's own `sid` session cookie never reaches sGTM, and they are never expired by name. All four count as ad storage.

## 1.4.0

### Minor Changes

- 862c8e4: expire non-consented analytics and marketing cookies, incl. HttpOnly FPID/FPLC, on every server response, and clear the browser-readable ones immediately on withdrawal through c15t's `clearOnRevocation` in `c15tPreset()`

## 1.3.0

### Minor Changes

- 8fbf92c: Server events now go to the Stape Data Client instead of the Measurement Protocol client: one flat JSON event per request, POSTed to `/data` by default, with `event_name`, `page_location`, `client_id`, `ip_override`, `user_agent`, the event params as top-level event data, `x-ga-gcs` (in the body and the request header), `user_data` and `_fbp`/`_fbc` under the same consent rules as before. The Measurement Protocol only fields (`timestamp_micros`, `events[]`, the `consent` object) and the `gcs` query parameter are gone.

  The server container needs the Data Client (`stape-io/data-client`, managed by `terraform-analytics`) installed; a container with only the Measurement Protocol client answers `400` to these hits. Rename the client's path in `serverEvents.path` if you changed it from `/data`.

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
