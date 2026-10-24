---
"@numoteq/analytics-kit": patch
---

Remove the `apiSecret` and `apiSecretVar` options: server events go to our sGTM, which forwards them to GA4 like browser hits and never needs Google's Measurement Protocol `api_secret`.
