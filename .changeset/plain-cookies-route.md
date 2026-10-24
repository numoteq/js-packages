---
"@numoteq/analytics-kit": minor
---

Server events no longer carry GA4 settings: the `measurementId` and `measurementIdVar` options, `session_id` and `measurement_id` in the hit, and the `sessionIdOf` export are removed. The sender instead forwards the visitor's consented analytics cookies (`_ga`, `_ga_*`, … with `measurement`, ad cookies with `marketing`) and the `x-forwarded-for` and `user-agent` headers, so the server container reads the session and the destinations are configured there alone. The send timeout now also covers reading the body of a refused hit, and `GtmScriptOptions` no longer offers `dataLayer`, which the loader would not follow.
