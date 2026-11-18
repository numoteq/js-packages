---
"@numoteq/analytics-kit": patch
---

Docs only, no code change: the consent categories are described as the ones our sites configure in c15t, now that the package ships no preset, and the proxy section no longer claims it never re-reads consent (`consentOfHit` reads `gcs` from the hit to expire the cookies the visitor did not allow).
