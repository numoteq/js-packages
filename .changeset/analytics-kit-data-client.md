---
"@numoteq/analytics-kit": minor
---

Server events now go to the Stape Data Client instead of the Measurement Protocol client: one flat JSON event per request, POSTed to `/data` by default, with `event_name`, `page_location`, `client_id`, `ip_override`, `user_agent`, the event params as top-level event data, `x-ga-gcs` (in the body and the request header), `user_data` and `_fbp`/`_fbc` under the same consent rules as before. The Measurement Protocol only fields (`timestamp_micros`, `events[]`, the `consent` object) and the `gcs` query parameter are gone.

The server container needs the Data Client (`stape-io/data-client`, managed by `terraform-analytics`) installed; a container with only the Measurement Protocol client answers `400` to these hits. Rename the client's path in `serverEvents.path` if you changed it from `/data`.
