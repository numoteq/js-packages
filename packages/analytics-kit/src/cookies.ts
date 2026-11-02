/**
 * Cookie cleanup: server-side expiry of analytics and marketing cookies the visitor has not
 * consented to. It is the only way to remove `HttpOnly` cookies such as `FPID` and `FPLC`, which
 * the sGTM GA4 client sets and JavaScript never sees.
 */

import { ANALYTICS_COOKIE, COOKIE_ALLOW } from "./rewrite.js";
import type { Consent } from "./server/context.js";

/** What expires a cookie: the two storage categories the forwarded cookies belong to. */
export type CookieConsent = Pick<Consent, "measurement" | "marketing">;

type Storage = "measurement" | "marketing";
type OptionalCategory = "functionality" | "experience" | "measurement" | "marketing";
type Decisions = Partial<Record<OptionalCategory, boolean>>;

/** The expired cookie is written without `Secure` and `SameSite`: browsers match on name, domain and path. */
const EXPIRES = "Thu, 01 Jan 1970 00:00:00 GMT";

/** c15t's consent record cookie, current and legacy names. Its other `c15t-*` records never match. */
const CONSENT_COOKIES = ["c15t", "privacy-consent-storage"];

const CATEGORY_CODES: Readonly<Record<string, OptionalCategory>> = {
	fn: "functionality",
	ex: "experience",
	mk: "marketing",
	me: "measurement",
};

/** c15t's shortened legacy keys, the reverse of its `COOKIE_KEY_MAP`. */
const LEGACY_KEYS: Readonly<Record<string, string>> = {
	i: "consentInfo",
	c: "consents",
	id: "id",
	eid: "externalId",
	idp: "identityProvider",
	sid: "subjectId",
	t: "time",
	ts: "timestamp",
	y: "type",
	mpf: "materialPolicyFingerprint",
	icv: "iabCustomVendorConsents",
	icvli: "iabCustomVendorLegitimateInterests",
};

const OPTIONAL_CATEGORIES = new Set<string>([
	"functionality",
	"experience",
	"measurement",
	"marketing",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
 * `v=3&b=…&me=1.1700000000.0` as c15t writes it. Any field c15t would reject makes the whole
 * record invalid, and an invalid record is a denial.
 */
function parseCompact(text: string): Decisions | undefined {
	const parts = text.split("&");
	if (parts[0] !== "v=3") return undefined;
	const fields = new Map<string, string>();
	for (const part of parts.slice(1)) {
		const separator = part.indexOf("=");
		if (separator <= 0) return undefined;
		const key = part.slice(0, separator);
		if (fields.has(key)) return undefined;
		fields.set(key, part.slice(separator + 1));
	}
	const bases = fields.get("b");
	const basisCount = bases === undefined ? 0 : bases === "" ? undefined : bases.split("|").length;
	if (basisCount === undefined) return undefined;
	const now = Date.now();
	const decisions: Decisions = {};
	for (const [key, value] of fields) {
		if (key === "b" || key === "e" || key === "sid" || key === "eid" || key === "idp") continue;
		if (key === "icv" || key === "icvli") continue;
		const category = CATEGORY_CODES[key];
		if (category === undefined) return undefined;
		const [flag, time, index] = value.split(".");
		const confirmedAt = time === undefined ? Number.NaN : Number(time);
		if (
			(flag !== "0" && flag !== "1") ||
			!Number.isSafeInteger(confirmedAt) ||
			confirmedAt < 0 ||
			confirmedAt > now ||
			index === undefined ||
			!/^\d+$/u.test(index) ||
			Number(index) >= basisCount
		) {
			return undefined;
		}
		decisions[category] = flag === "1";
	}
	return decisions;
}

function parseJson(text: string): Decisions | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	const categories = value.categories;
	if (value.version === 3) {
		if (!isRecord(categories)) return undefined;
		const decisions: Decisions = {};
		for (const [category, decision] of Object.entries(categories)) {
			if (!OPTIONAL_CATEGORIES.has(category)) return undefined;
			if (!isRecord(decision) || typeof decision.value !== "boolean") return undefined;
			if (typeof decision.confirmedAt !== "number" || !isRecord(decision.basis)) return undefined;
			decisions[category as OptionalCategory] = decision.value;
		}
		return decisions;
	}
	const consents = value.consents;
	if (!isRecord(consents)) return undefined;
	const decisions: Decisions = {};
	for (const [category, granted] of Object.entries(consents)) {
		if (category === "necessary") continue;
		if (!OPTIONAL_CATEGORIES.has(category)) continue;
		if (typeof granted !== "boolean") return undefined;
		decisions[category as OptionalCategory] = granted;
	}
	return decisions;
}

/** The pre-v3 `c.measurement:1,i.t:1700000000` form. */
function parseLegacyCompact(text: string): Decisions | undefined {
	const decisions: Decisions = {};
	for (const pair of text.split(",")) {
		const separator = pair.indexOf(":");
		if (separator <= 0) return undefined;
		const path = pair
			.slice(0, separator)
			.split(".")
			.map((segment) => LEGACY_KEYS[segment] ?? segment);
		const value = pair.slice(separator + 1);
		if (path.length !== 2 || path[0] !== "consents") continue;
		const category = path[1]!;
		if (category === "necessary" || !OPTIONAL_CATEGORIES.has(category)) continue;
		if (value !== "1" && value !== "0") return undefined;
		decisions[category as OptionalCategory] = value === "1";
	}
	return decisions;
}

/** One stored record in any form c15t has written, or `undefined` when it is none of them. */
function parseForm(candidate: string): Decisions | undefined {
	if (candidate === "v=3" || candidate.startsWith("v=3&")) return parseCompact(candidate);
	if (candidate.startsWith("{")) return parseJson(candidate);
	if (candidate.includes(":")) return parseLegacyCompact(candidate);
	return undefined;
}

function parseDecisions(text: string): Decisions {
	const trimmed = text.trim();
	if (trimmed === "") return {};
	const direct = parseForm(trimmed);
	if (direct !== undefined) return direct;
	if (trimmed.includes("%")) {
		try {
			const decoded = parseForm(decodeURIComponent(trimmed).trim());
			if (decoded !== undefined) return decoded;
		} catch {
			// A broken escape is as invalid as a broken record.
		}
	}
	return {};
}

/**
 * Consent as c15t wrote it in its cookie. A missing, unreadable or malformed cookie grants
 * nothing, so the cleanup errs towards deleting.
 */
export function consentFromCookieHeader(header: string | null | undefined): CookieConsent {
	const jar = cookieValues(header);
	for (const name of CONSENT_COOKIES) {
		const value = jar.get(name);
		if (value === undefined) continue;
		const decisions = parseDecisions(value);
		return {
			measurement: decisions.measurement === true,
			marketing: decisions.marketing === true,
		};
	}
	return { measurement: false, marketing: false };
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
 * left alone, and a response with nothing to expire is returned as it is. Without `consent` the
 * visitor's c15t cookie decides, which is what a proxy response can rely on: no middleware ran
 * on it, so there are no locals to read.
 */
export function expireUnconsentedCookies(
	response: Response,
	request: Request,
	consent?: CookieConsent,
): Response {
	const cookieHeader = request.headers.get("cookie");
	const expired = expiredCookieHeaders(
		cookieHeader,
		consent ?? consentFromCookieHeader(cookieHeader),
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
