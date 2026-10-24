/** What a server event needs to know about the request that caused it. */

import { filterCookies } from "../rewrite.js";

/** Consent categories, the same names the c15t preset offers. */
export type ConsentCategory =
	| "necessary"
	| "functionality"
	| "experience"
	| "measurement"
	| "marketing";

/** What the visitor allowed. A missing category counts as denied. */
export type Consent = Partial<Record<ConsentCategory, boolean>>;

export interface RequestContext {
	/**
	 * `client_id` from `_ga`, the id GA4 uses to join this event to the visitor's session. Absent
	 * without consent, because the cookie is not there; the sender then generates a fresh one.
	 */
	readonly clientId?: string;
	/**
	 * The analytics cookies the proxy forwards too, such as `_ga_<id>`: sGTM reads the session from
	 * them, so the Worker needs no GA4 settings. The sender passes on only the consented ones.
	 */
	readonly cookie?: string;
	readonly ip?: string;
	readonly userAgent?: string;
	/** The page the visitor was on, from `Referer`; `page_location` of the event. */
	readonly pageLocation?: string;
	readonly fbp?: string;
	readonly fbc?: string;
	readonly consent: Consent;
}

function cookies(header: string | null): Map<string, string> {
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

/** `GA1.1.123.456` → `123.456`: the client id is the last two parts of `_ga`. */
export function clientIdOf(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const parts = value.split(".");
	return parts.length < 3 ? undefined : parts.slice(-2).join(".");
}

/** The click id Meta reads from `_fbc`; without the cookie, rebuild it from `fbclid`. */
function fbcOf(cookie: string | undefined, fbclid: string | undefined): string | undefined {
	if (cookie) return cookie;
	if (!fbclid) return undefined;
	return `fb.1.${Date.now()}.${fbclid}`;
}

function fbclidOf(referer: string | undefined): string | undefined {
	if (!referer) return undefined;
	try {
		return new URL(referer).searchParams.get("fbclid") ?? undefined;
	} catch {
		return undefined;
	}
}

function ipOf(request: Request): string | undefined {
	const forwarded = request.headers.get("cf-connecting-ip");
	if (forwarded) return forwarded;
	const chain = request.headers.get("x-forwarded-for");
	return chain?.split(",")[0]?.trim() || undefined;
}

/**
 * Reads the visitor's identifiers, address and consent off the request. Call this at the moment
 * the event happens, not when the handler is built: the consent middleware of c15t runs later and
 * the cookies are whatever the browser sent with this request.
 */
export function fromRequest(request: Request, consent: Consent = {}): RequestContext {
	const header = request.headers.get("cookie");
	const jar = cookies(header);
	const referer = request.headers.get("referer") ?? undefined;
	return {
		clientId: clientIdOf(jar.get("_ga")),
		cookie: filterCookies(header) || undefined,
		ip: ipOf(request),
		userAgent: request.headers.get("user-agent") ?? undefined,
		pageLocation: referer,
		fbp: jar.get("_fbp"),
		fbc: fbcOf(jar.get("_fbc"), fbclidOf(referer)),
		consent,
	};
}

export const RequestContext = { fromRequest };
