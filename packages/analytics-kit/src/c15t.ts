/**
 * c15t integration: a preset for the Astro integration and the Google Tag Manager container as a
 * script. Kept free of runtime-only dependencies, because `astro.config.mjs` imports it too.
 */

import {
	googleTagManager,
	type GoogleTagManagerOptions,
} from "@c15t/integrations/google-tag-manager";
import { offline, type C15tAstroOptions, type Script } from "c15t/astro";

import { loaderPath } from "./paths.js";

export type C15tPreset = C15tAstroOptions;

/**
 * Options for `c15t()` in `astro.config.mjs`: our categories, offline mode and c15t's recommended
 * policy pack. Anything a client passes wins, so texts, legal links, theme and policy rules stay
 * per site.
 */
export function c15tPreset(overrides: C15tAstroOptions = {}): C15tPreset {
	return {
		mode: offline(),
		consentCategories: ["necessary", "measurement", "marketing"],
		...overrides,
	};
}

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
 * `C15tClientOptionsExtension.scripts` (e.g. `src/c15t.client.ts`), not in the serialized options.
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
