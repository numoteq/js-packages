/**
 * Cookie cleanup: server-side expiry of analytics and marketing cookies the visitor has not
 * consented to. It is the only way to remove `HttpOnly` cookies such as `FPID` and `FPLC`, which
 * the sGTM GA4 client sets and JavaScript never sees.
 *
 * The consent comes from the hit itself, the `gcs` parameter Google Consent Mode puts on every
 * hit: the same value sGTM reads. A request that carries none deletes nothing, and the visitor's
 * next hit does the work.
 */

import { ANALYTICS_COOKIE, COOKIE_ALLOW } from "./rewrite.js";
import type { Consent } from "./server/context.js";

/** What expires a cookie: the two storage categories the forwarded cookies belong to. */
export type CookieConsent = Pick<Consent, "measurement" | "marketing">;

type Storage = "measurement" | "marketing";

/** The expired cookie is written without `Secure` and `SameSite`: browsers match on name, domain and path. */
const EXPIRES = "Thu, 01 Jan 1970 00:00:00 GMT";

/** `gcs` is `G1`, then `ad_storage`, then `analytics_storage`: `1` granted, `0` denied, `-` unset. */
const GCS = /^G1([01-])([01-])$/u;

/** Which storage a forwarded cookie belongs to, or `undefined` for a cookie we leave alone. */
export function storageOf(name: string): Storage | undefined {
	if (!COOKIE_ALLOW.test(name)) return undefined;
	return ANALYTICS_COOKIE.test(name) ? "measurement" : "marketing";
}

function cookieValues(header: string | null | undefined): Map<string, string> {
	const jar = new Map<string, string>();
	if (!header) return jar;
	for (const pair of header.split(";")) {
		const trimmed = pair.trim();
		const separator = trimmed.indexOf("=");
		if (separator <= 0) continue;
		jar.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
	}
	return jar;
}

/**
 * The consent a hit carries, from the `gcs` query parameter or, on a POST hit, from its form body.
 * Only an explicit `0` counts as denied; a missing, `-` or unreadable value grants the category,
 * so a hit we cannot read deletes nothing.
 */
export function consentOfHit(target: string, body?: Uint8Array): CookieConsent {
	const granted: CookieConsent = { measurement: true, marketing: true };
	const url = new URL(target, "https://sgtm.invalid");
	const fromQuery = url.searchParams.get("gcs");
	const fromBody =
		fromQuery === null && body !== undefined
			? new URLSearchParams(new TextDecoder().decode(body)).get("gcs")
			: null;
	const gcs = fromQuery ?? fromBody;
	if (gcs === null) return granted;

	const match = GCS.exec(gcs);
	if (match === null) return granted;
	return {
		marketing: match[1] !== "0",
		measurement: match[2] !== "0",
	};
}

/** Second-level labels that host public suffixes, so `co.uk` needs three labels. */
const SECOND_LEVEL_SUFFIXES = new Set([
	"ac",
	"biz",
	"co",
	"com",
	"edu",
	"go",
	"gob",
	"gov",
	"govt",
	"info",
	"mil",
	"ne",
	"net",
	"nom",
	"or",
	"org",
	"sch",
	"web",
]);

/**
 * The registrable domain (`eTLD+1`) of a host, or `undefined` for `localhost`, an IP literal or a
 * single label. A small heuristic, not the Public Suffix List: it knows `www.` and the usual
 * two-label suffixes (`co.uk`, `com.au`, …), so a country domain such as `example.cz` resolves
 * correctly while rare multi-label public suffixes do not.
 */
export function registrableDomain(host: string): string | undefined {
	const name = host
		.trim()
		.toLowerCase()
		.replace(/^\.+/u, "")
		.replace(/\.+$/u, "")
		.replace(/:\d+$/u, "");
	if (name === "" || name === "localhost" || name.includes(":") || name.includes("/")) {
		return undefined;
	}
	const labels = name.split(".");
	if (labels.length < 2 || labels.some((label) => label === "")) return undefined;
	if (/^\d{1,3}(\.\d{1,3}){3}$/u.test(name)) return undefined;
	const tld = labels.at(-1)!;
	const second = labels.at(-2)!;
	const twoLabelSuffix = tld.length === 2 && SECOND_LEVEL_SUFFIXES.has(second);
	const keep = twoLabelSuffix ? 3 : 2;
	return labels.length <= keep ? name : labels.slice(-keep).join(".");
}

function expiry(name: string, domain?: string): string {
	const scoped = domain === undefined ? "" : `; Domain=${domain}`;
	return `${name}=; Path=/; Max-Age=0; Expires=${EXPIRES}${scoped}`;
}

/**
 * `Set-Cookie` values that expire every analytics and marketing cookie of the request whose
 * consent is not granted, each once host-only and once on the registrable domain: sGTM sets
 * `FPID` on the eTLD+1 and GA sets `_ga` there too, so a host-only deletion alone would leave the
 * cookie alive on the parent. Nothing outside the proxy's allowlist is touched; `c15t*` never is.
 */
export function expiredCookieHeaders(
	cookieHeader: string | null | undefined,
	consent: CookieConsent,
	host: string,
): string[] {
	if (!cookieHeader) return [];
	const granted = {
		measurement: consent.measurement === true,
		marketing: consent.marketing === true,
	};
	if (granted.measurement && granted.marketing) return [];
	const domain = registrableDomain(host);
	const headers: string[] = [];
	for (const name of cookieValues(cookieHeader).keys()) {
		const storage = storageOf(name);
		if (storage === undefined || granted[storage]) continue;
		headers.push(expiry(name));
		if (domain !== undefined) headers.push(expiry(name, domain));
	}
	return headers;
}

/**
 * The response with the expired cookies appended, every existing `Set-Cookie` kept. The body is
 * left alone, and a response with nothing to expire is returned as it is.
 */
export function expireUnconsentedCookies(
	response: Response,
	request: Request,
	consent: CookieConsent,
): Response {
	const expired = expiredCookieHeaders(
		request.headers.get("cookie"),
		consent,
		new URL(request.url).host,
	);
	if (expired.length === 0) return response;
	const headers = new Headers(response.headers);
	for (const cookie of expired) headers.append("set-cookie", cookie);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
