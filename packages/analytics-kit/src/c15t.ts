/**
 * c15t integration: the Google Tag Manager container as a script, and the cookies a withdrawal
 * has to delete in the browser. Kept free of runtime-only dependencies, because
 * `astro.config.mjs` imports it too.
 *
 * The consent configuration itself — policy mode, categories, labels, theme — belongs to the site
 * (`src/components/ui/cookie-consent/config.ts`), not here.
 */

import {
	googleTagManager,
	type GoogleTagManagerOptions,
} from "@c15t/integrations/google-tag-manager";
import type { Script } from "c15t/astro";

import { loaderPath } from "./paths.js";
import { MARKETING_COOKIE_PATTERNS, MEASUREMENT_COOKIE_PATTERNS } from "./rewrite.js";

/**
 * The cookies a withdrawal of `measurement` deletes in the browser, in c15t's `clearOnRevocation`
 * shape. The server expires the same cookies under `gcs` from the hit, plus the `HttpOnly` ones
 * JavaScript cannot reach, so both halves stay in step.
 */
export const measurementCookies: readonly string[] = MEASUREMENT_COOKIE_PATTERNS;

/** The cookies a withdrawal of `marketing` deletes in the browser. */
export const marketingCookies: readonly string[] = MARKETING_COOKIE_PATTERNS;

/**
 * No `dataLayer`: c15t would queue consent into the renamed layer, while our loader serves gtm.js
 * without `l=` and the container keeps listening to `dataLayer`.
 */
export interface GtmScriptOptions extends Omit<GoogleTagManagerOptions, "id" | "dataLayer"> {
	/** Only fills the Google URL we replace; the Worker reads the real id from `GTM_ID`. */
	readonly id?: string;
	/** Host the loader path derives from. Defaults to `location.host`; pass it on the server. */
	readonly host?: string;
}

/**
 * The web container as a c15t script: `googleTagManager()` with the container URL pointed at our
 * loader, so gtm.js is first-party and our shim is installed before it. Put it in
 * `C15tClientOptionsExtension.scripts` (e.g. `src/components/ui/cookie-consent/client.ts`), not in
 * the serialized options.
 *
 * Returns `undefined` when no host is known, which is the server and build time; the caller then
 * exports `scripts: []`.
 */
export function gtmScript(options: GtmScriptOptions = {}): Script | undefined {
	const { host, id = "GTM-000000", ...gtm } = options;
	const resolvedHost = host ?? (typeof location === "undefined" ? undefined : location.host);
	if (resolvedHost === undefined) return undefined;
	return { ...googleTagManager({ ...gtm, id }), src: loaderPath(resolvedHost) };
}

/** `C15tClientOptionsExtension` with the container script, or none on the server. */
export function gtmScripts(options: GtmScriptOptions = {}): Script[] {
	const script = gtmScript(options);
	return script === undefined ? [] : [script];
}
