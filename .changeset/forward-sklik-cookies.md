---
"@numoteq/analytics-kit": minor
---

Forward the cookies Sklik and Google Ads server tags read to sGTM: `sznaiid`, `_dm_session_attributes`, and Seznam's `sid` and `udid` from `sul.js`. `sid` and `udid` pass only in Seznam's value format, so a site's own `sid` session cookie never reaches sGTM, and they are never expired by name. All four count as ad storage.
