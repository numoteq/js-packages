---
"@numoteq/analytics-kit": major
---

Drop astro 6 support: the `astro` peer range moves from `>=6` to `>=7.4.7`. Two of the advisories this release covers are fixed only in the 7.x line — the string tag name filter (7.4.5) and the `/_image` path check of `@astrojs/node` (7.4.7, GHSA-r3h5-4585-7x3w) — and the astro 6 line ends at 6.4.8, so no 6.x release carries the `/_image` fix. A site on astro 6 now gets a peer conflict instead of an install that keeps a vulnerable astro. Upgrade to astro 7.4.7 or later to use this version; `@astrojs/cloudflare` 13 and 14 stay supported.
