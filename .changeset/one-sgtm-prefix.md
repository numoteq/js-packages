---
"@numoteq/analytics-kit": patch
---

Drop the leftovers of several upstreams: the `PREFIX`, `PREFIXES` and `UpstreamName` exports are removed (use `SGTM_PREFIX`), and the proxy keeps one optional sGTM client instead of a map of upstreams. Behaviour is unchanged.
