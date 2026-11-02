---
"@numoteq/analytics-kit": minor
---

expire non-consented analytics and marketing cookies, incl. HttpOnly FPID/FPLC, on every server response, and clear the browser-readable ones immediately on withdrawal through c15t's `clearOnRevocation` in `c15tPreset()`
