# `@numoteq/analytics-kit`

First-party analytics plumbing for sites on Cloudflare Workers and Astro. One package, four parts:

- **A proxy** to self-hosted server-side Google Tag Manager (sGTM), reachable from the page without ad-blocker-shaped URLs.
- **Server events** that send from an API route or an action through the Measurement Protocol client of our sGTM, with the visitor's identifiers, address and consent.
- **A c15t preset** with our consent categories and the container script that loads through the proxy.
- **Client paths** with no dependencies, for the page.

Built on [Effect](https://effect.website) v4. The core is configured at runtime, so one build serves production, previews and local development.

```sh
pnpm add @numoteq/analytics-kit effect
# Astro sites also: astro (6 or 7) and @astrojs/cloudflare (13 or 14)
# c15t sites also: c15t @c15t/integrations
```

## Proxy

Ad blockers do not only block `www.googletagmanager.com`. EasyPrivacy and the AdGuard filters also match the URL shapes of a first-party proxy (`/gtm.js`, `?id=GTM-`, `/gtag/js?`, `?v=2&tid=G-`), so a plain reverse proxy on your own domain gets filtered anyway. The proxy avoids every such shape:

1. **Hashed paths.** The container loads from `/<hash>.js` and requests go to `/<hash>/<token>`. The hash derives from the site host, so the page and the Worker agree without configuration and no two sites share a path.
2. **Rewritten hosts.** In every script served from sGTM, `www.googletagmanager.com` becomes `<site>/_sgtm`, so the container loads its dependencies and sends its hits first-party.
3. **A shim** in front of the container encodes every data request under `/_sgtm` into a random-looking token. It hooks only what gtm.js and gtag.js send with: `fetch`, `navigator.sendBeacon` and the `src` of script and image elements.
4. **The Worker** decodes tokens back into the path, strips the prefix and forwards them to sGTM.

The shim never loads GTM's service worker iframe, so gtag sends every hit from the page, without a failed request.

The `sgtm` upstream (`SGTM_UPSTREAM`) carries everything the container sends: `/gtm.js`, `/gtag/js`, `/g/collect`, … Without it the loader serves an empty script and `/_sgtm` answers `404`.

### Astro

```js
// astro.config.mjs
import { analytics } from "@numoteq/analytics-kit/astro";

export default defineConfig({
	integrations: [analytics() /* , emdash(), c15t(), … */],
});
```

The integration adds middleware that runs before every other middleware and sets `locals.analytics` (see [Server events](#server-events)). It reads the Worker env at runtime:

```jsonc
// wrangler.jsonc
{
	"vars": { "GTM_ID": "GTM-XXXXXXX" },
	"vpc_services": [{ "binding": "SGTM_UPSTREAM", "service_id": "<id>", "remote": true }],
}
```

- `GTM_ID` is the id of the **web** container whose `gtm.js` is loaded, not of the server container. sGTM knows its own container from its deployment.
- `SGTM_UPSTREAM` reaches sGTM: a Workers VPC binding keeps it off the public internet; a service binding works too, and so does a plain origin such as `https://sgtm.example.com` (no path).

Server events are on whenever `SGTM_UPSTREAM` is set; the middleware sets `locals.analytics` on every request. Other names:

```js
analytics({
	gtmIdVar: "WEB_GTM",
	sgtmBinding: "TAGGING",
	serverEvents: { apiSecretVar: "MP_SECRET" },
});
```

### The loader

Load the container from the path for the current host, for example as the script of a consent manager:

```ts
import { loaderPath } from "@numoteq/analytics-kit/client";

const src = loaderPath(location.host);
```

`@numoteq/analytics-kit/client` has no dependencies. Do not add `integrity` to the script: the loader is assembled per site and has no stable hash.

### Other frameworks

`createProxyHandler(options)` returns `(request: Request) => Promise<Response | null>`; `null` means the request belongs to the site. Create it once per isolate:

```ts
import { createProxyHandler } from "@numoteq/analytics-kit";

const handler = createProxyHandler({
	gtmId: env.GTM_ID,
	sgtm: env.SGTM_UPSTREAM,
});
const response = (await handler(request)) ?? (await site(request));
```

### Behaviour

- **Loader:** fetched from sGTM with up to two retries and a 10 s timeout per attempt, then cached for 5 minutes in the Workers Cache API. Server-side preview requests (`X-Gtm-Server-Preview`) and responses that set cookies bypass the cache; a preview is answered `Cache-Control: no-store` with `Vary: X-Gtm-Server-Preview`, so no edge cache can hand it to a normal visitor.
- **Encoded requests:** forwarded once with a 5 s timeout. A hit is never retried, so it cannot count twice.
- **Headers:** everything the browser sent is forwarded, Cloudflare's `cf-*` included, so sGTM tags can read `cf-ipcountry` and friends. Cookies are narrowed to `_ga*`, `_gid`, `_gcl_*`, `_fbp`, `_fbc`, `FPID`, `FPLC`, `FPAU`, `FPGCL*`, `FPGSID` and `_gtmeec`. `x-forwarded-for`, `-host` and `-proto` describe the original request (the first is rebuilt from `cf-connecting-ip`, so only on Cloudflare), and `authorization` never leaves the site.
- **Failures:** an upstream that is unreachable or too slow answers `502` and logs a warning, an unknown token or a path under no prefix `400`, a plain data request under a prefix `404`. The site's own error page never shows.
- **Turned off:** a part with missing or invalid options logs why once and turns itself off. The loader then answers an empty script with `Cache-Control: no-store`, so pages in previews and local development load quietly.
- **Logs:** JSON, only for the cases above. Workers Logs already record every request.

### GTM setup

Server container:

- **Container Settings → Server container URL:** `https://<site>/_sgtm`. It does not affect routing: the Worker forwards default paths, which sGTM accepts with or without the URL's path.
- **Clients:** a **Google Tag Manager: Web Container** client allowing your web container id, the **GA4** client, and a **Measurement Protocol** client (see [Server events](#server-events)). Check that `/gtm.js?id=<id>` on sGTM returns JavaScript.

Web container:

- The Google tag's `server_container_url` is the same `https://<site>/_sgtm`.
- Remove the standard GTM snippet; the page loads the container from the loader path.

## Server events

Conversions the backend confirms (a lead stored, an order paid) are sent from the Worker, not the browser: they survive ad blockers and closed tabs. The event originates on the server and goes through sGTM, which routes it to GA4, Meta CAPI, Umami and OpenPanel like any other hit.

Server container: add a **Measurement Protocol** client and note its activation path. Give the sender that path (default `/mp/collect`). The Worker knows nothing about the destinations: the GA4 measurement id, the Umami website, the Meta pixel and the rest are set in the server container's tags. `api_secret` is an optional pass-through field; the container itself accepts any value.

```ts
// an Astro action or API route, after the lead is stored
await locals.analytics.event("generate_lead", { form_id: "contact" });

// with the data Meta and Google want for a conversion
await locals.analytics.event(
	"generate_lead",
	{ form_id: "contact" },
	{ user: { email: "jan@example.com", phone: "+420 777 123 456" } },
);
```

`locals.analytics.event(name, params, options)`:

- sends in the background through `waitUntil`, so the response does not wait for it; the returned promise exists so a test can await it,
- reads consent at call time from `Astro.locals.c15t.snapshot.effectivePermissions`, because c15t's middleware runs after ours; without c15t everything counts as denied (`gcs=G100`) and you pass consent to `createServerEvents` yourself,
- never throws: a failed event is logged and dropped.

The sender adds what the browser would have sent, read from the request:

| Field | Source | Sent with |
| --- | --- | --- |
| `page_location` | the request's `Referer`, or a `pageLocation` you pass | always |
| `ip_override`, `user_agent`, also as `x-forwarded-for` and `user-agent` headers | `cf-connecting-ip` (or `x-forwarded-for`), `user-agent` | always |
| `client_id` | `_ga`; a random UUID when there is no cookie or analytics consent | `measurement` |
| `cookie` header: `_ga`, `_ga_*`, `_gid`, `FPID`, `FPLC`, `FPGSID` | the request's cookies | `measurement` |
| `cookie` header: the other forwarded cookies (`_gcl_*`, `_fbp`, `_fbc`, …) | the request's cookies | `marketing` |
| `_fbp` / `_fbc` | the cookies; `_fbc` is rebuilt from `fbclid` when the cookie is not there yet | `marketing` |
| `user_data.sha256_email_address`, `sha256_phone_number` | `user: { email, phone }`, normalized and SHA-256 hashed in the Worker | `marketing` |

The Worker sends no `session_id`: it would need to know the GA4 property to pick its `_ga_<id>` cookie. The consented cookies go along instead, the same allowlist the proxy forwards, and the server container reads the session from them (for example a Cookie Value variable for `_ga_<id>` and a transformation that sets `ga_session_id` on Measurement Protocol events). A hashed e-mail is still personal data, so it travels only with marketing consent; the plain values never leave the Worker. The IP, the user agent and the page are the open part of the hit (Meta matches on them without cookies) and go out even when nothing is granted.

Consent goes both ways: the MP body's `consent` object for the record, and the `gcs` query parameter (`G1` + ad + analytics, the same signal gtag sends). Server tags read consent from `x-ga-gcs`, which the Measurement Protocol client builds from `gcs`; the claim comes from the container bytecode, so confirm one hit in the sGTM Preview after you change it.

Without Effect, `createServerEvents(options)` returns `{ send(request, event, consent) }`; it is the sender alone, so it needs `upstream` again. Without an upstream it logs why once and drops events. With Effect, use the `ServerEvents` service; `./server` exports it with `RequestContext`, `gcsOf` and the typed errors:

```ts
import { Effect } from "effect";
import { RequestContext, ServerEvents } from "@numoteq/analytics-kit/server";

const program = Effect.gen(function* () {
	const events = yield* ServerEvents;
	yield* events.send(RequestContext.fromRequest(request, consent, "G-XXXXXXXXXX"), {
		name: "generate_lead",
		params: { form_id: "contact" },
	});
});
```

`createAnalytics({ gtmId, sgtm, serverEvents })` builds the proxy and the sender on **one** runtime and returns `{ handle, send }`; that is what the Astro integration uses. `serverEvents: false` turns the sender off silently, for a site that only proxies. `createProxyHandler(options)` is `handle` alone, `createServerEvents(options)` is `send` alone.

An event is sent once. No vendor downstream deduplicates a repeated event, and a `fetch` that fails cannot be told apart from one that arrived and lost its answer, so there is no retry.

## c15t

```js
// astro.config.mjs
import { c15tPreset } from "@numoteq/analytics-kit/c15t";
import { c15t } from "c15t/astro";

export default defineConfig({
	integrations: [
		c15t(
			c15tPreset({
				// anything a client needs: i18n, legalLinks, presentation, theme, policy rules
			}),
		),
	],
});
```

`c15tPreset()` sets our categories (`necessary`, `measurement`, `marketing`), offline mode and c15t's recommended policy pack. Every key you pass wins.

The container script belongs in the client entrypoint (`src/c15t.client.ts`), not in the serialized options, because it carries callbacks:

```ts
import { gtmScripts } from "@numoteq/analytics-kit/c15t";
import type { C15tClientOptionsExtension } from "c15t/astro";

export default {
	scripts: gtmScripts(), // [] on the server, one script in the browser
} satisfies C15tClientOptionsExtension;
```

`gtmScripts()` is `googleTagManager()` from `@c15t/integrations` with the container URL pointed at our loader: gtm.js is served first-party and the shim is installed before it. It defaults to advanced consent mode (`loadMode: "always"`, category `necessary`), where GTM loads before the visitor chooses and sends cookieless pings to our sGTM. Pass `loadMode: "after-consent"` for basic mode. The container id never reaches the page; the Worker adds the real one from `GTM_ID`.

## Limits

- Requests the browser sends straight to Google or Meta domains (Ads conversion pings, `google.com/ccm`, the Meta pixel) are not proxied. Move those tags into the server container.
- The shim hooks `fetch` with a string or `URL`, `sendBeacon` and the `src` of script and image elements. It does not hook `XMLHttpRequest`, `setAttribute("src")` or `fetch(new Request(…))`. A script you add to the page must send through the hooked channels to be proxied.
- The token is obfuscation, not encryption: the shim carries everything needed to decode it. It defeats static URL patterns and authenticates nothing.
- The proxy is transport only. It does not read, set or bypass consent; keep consent mode and your CMP as they are.

## Development

```sh
pnpm test
pnpm typecheck
pnpm build
```

`tests/fixtures/gtm-excerpt.js.txt` holds verbatim excerpts of a real `gtm.js` covering every place the container host appears.
