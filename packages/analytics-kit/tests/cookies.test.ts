import { describe, expect, it } from "@effect/vitest";

import {
	consentFromCookieHeader,
	expireUnconsentedCookies,
	expiredCookieHeaders,
	registrableDomain,
	storageOf,
} from "../src/cookies.js";
import { MARKETING_COOKIE_PATTERNS, MEASUREMENT_COOKIE_PATTERNS } from "../src/rewrite.js";

const HOST = "www.example.com";
const EXPIRES = "Thu, 01 Jan 1970 00:00:00 GMT";
const AT = 1_700_000_000_000;

const expiry = (name: string, domain?: string) =>
	`${name}=; Path=/; Max-Age=0; Expires=${EXPIRES}${domain === undefined ? "" : `; Domain=${domain}`}`;

/** A c15t v3 record with the given category decisions. */
const v3 = (decisions: Record<string, boolean>) => {
	const codes = { functionality: "fn", experience: "ex", measurement: "me", marketing: "mk" };
	const fields = Object.entries(decisions).map(
		([category, granted]) => `${codes[category as keyof typeof codes]}=${granted ? 1 : 0}.${AT}.0`,
	);
	// The order c15t's encoder writes: version, subject, epoch, bases, then the decisions.
	return ["v=3", "sid=subject", `b=c${"a".repeat(8)}`, ...fields].join("&");
};

/** A concrete cookie name for an allowlist pattern. */
const sample = (pattern: string) => pattern.replace(/\*$/u, "TEST");

describe("cookie lists", () => {
	it("keeps the browser patterns and the server allowlist in step", () => {
		for (const pattern of MEASUREMENT_COOKIE_PATTERNS) {
			expect({ pattern, storage: storageOf(sample(pattern)) }).toEqual({
				pattern,
				storage: "measurement",
			});
		}
		for (const pattern of MARKETING_COOKIE_PATTERNS) {
			expect({ pattern, storage: storageOf(sample(pattern)) }).toEqual({
				pattern,
				storage: "marketing",
			});
		}
	});
});

describe("registrableDomain", () => {
	it.each([
		["www.example.com", "example.com"],
		["example.com", "example.com"],
		["www.example.com:443", "example.com"],
		["www.example.cz", "example.cz"],
		["example.cz", "example.cz"],
		["app.example.co.uk", "example.co.uk"],
		["localhost", undefined],
		["localhost:4321", undefined],
		["127.0.0.1", undefined],
		["[::1]", undefined],
	])("%s → %s", (host, domain) => {
		expect(registrableDomain(host)).toBe(domain);
	});
});

describe("expiredCookieHeaders", () => {
	it("expires analytics and marketing cookies without consent, host-only and on the eTLD+1", () => {
		expect(expiredCookieHeaders("_ga=1; FPID=2; _fbp=3", {}, HOST)).toEqual([
			expiry("_ga"),
			expiry("_ga", "example.com"),
			expiry("FPID"),
			expiry("FPID", "example.com"),
			expiry("_fbp"),
			expiry("_fbp", "example.com"),
		]);
	});

	it("leaves the analytics cookies of a measurement-granted visitor alone", () => {
		expect(
			expiredCookieHeaders(
				"_ga=1; _ga_ABC=1; _gid=2; FPID=3; FPLC=4; _fbp=5",
				{ measurement: true },
				HOST,
			),
		).toEqual([expiry("_fbp"), expiry("_fbp", "example.com")]);
	});

	it("expires nothing when both storages are granted", () => {
		expect(
			expiredCookieHeaders("_ga=1; FPID=2; _fbp=3", { measurement: true, marketing: true }, HOST),
		).toEqual([]);
	});

	it("never touches the c15t consent records or cookies outside the allowlist", () => {
		expect(
			expiredCookieHeaders(
				"c15t=v=3&me=1.1700000000000.0; c15t-notice=v=1&t=1; c15t-epoch=1; session=abc; astro-session=1",
				{},
				HOST,
			),
		).toEqual([]);
	});

	it("covers the whole ads allowlist, and skips a host with no registrable domain", () => {
		expect(
			expiredCookieHeaders("_gcl_au=1; _fbc=2; FPAU=3; FPGCLDC=4; _gtmeec=5", {}, "localhost"),
		).toEqual([
			expiry("_gcl_au"),
			expiry("_fbc"),
			expiry("FPAU"),
			expiry("FPGCLDC"),
			expiry("_gtmeec"),
		]);
	});

	it("has nothing to do without a cookie header", () => {
		expect(expiredCookieHeaders(undefined, {}, HOST)).toEqual([]);
		expect(expiredCookieHeaders("", {}, HOST)).toEqual([]);
	});
});

describe("consentFromCookieHeader", () => {
	it("reads a v3 compact record", () => {
		const consent = consentFromCookieHeader(
			`session=abc; c15t=${v3({ measurement: true, marketing: false })}`,
		);

		expect(consent).toEqual({ measurement: true, marketing: false });
	});

	it("reads a v3 JSON record", () => {
		const value = JSON.stringify({
			version: 3,
			categories: {
				measurement: {
					value: true,
					confirmedAt: AT,
					basis: { kind: "choice-v1", fingerprint: "f" },
				},
			},
		});

		expect(consentFromCookieHeader(`c15t=${encodeURIComponent(value)}`)).toEqual({
			measurement: true,
			marketing: false,
		});
	});

	it("reads the legacy compact and JSON records", () => {
		expect(consentFromCookieHeader(`c15t=c.measurement:1,c.marketing:0,i.t:${AT}`)).toEqual({
			measurement: true,
			marketing: false,
		});
		expect(
			consentFromCookieHeader(
				`c15t=${encodeURIComponent(JSON.stringify({ consentInfo: { time: AT }, consents: { marketing: true } }))}`,
			),
		).toEqual({ measurement: false, marketing: true });
	});

	it("reads the legacy cookie name too", () => {
		expect(consentFromCookieHeader(`privacy-consent-storage=${v3({ measurement: true })}`)).toEqual(
			{
				measurement: true,
				marketing: false,
			},
		);
	});

	it("grants nothing for a missing, unknown or malformed cookie", () => {
		const denied = { measurement: false, marketing: false };
		expect(consentFromCookieHeader(undefined)).toEqual(denied);
		expect(consentFromCookieHeader("session=abc")).toEqual(denied);
		expect(consentFromCookieHeader("c15t=garbage")).toEqual(denied);
		expect(consentFromCookieHeader("c15t=v=4&me=1.1700000000000.0")).toEqual(denied);
		expect(consentFromCookieHeader(`c15t=v=3&mk=maybe`)).toEqual(denied);
		expect(consentFromCookieHeader("c15t=v=3&me=1.1700000000000.0&unknown=1")).toEqual(denied);
		// c15t rejects a decision that has no basis list, so it grants nothing either.
		expect(consentFromCookieHeader(`c15t=v=3&sid=abc&me=1.${AT}.0`)).toEqual(denied);
	});
});

const request = (cookie: string) =>
	new Request(`https://${HOST}/page`, { headers: cookie === "" ? {} : { cookie } });

describe("expireUnconsentedCookies", () => {
	it("appends the expiries and keeps the body", async () => {
		const response = expireUnconsentedCookies(new Response("page"), request("_ga=1; FPID=2"), {});

		expect(response.headers.getSetCookie()).toEqual([
			expiry("_ga"),
			expiry("_ga", "example.com"),
			expiry("FPID"),
			expiry("FPID", "example.com"),
		]);
		expect(await response.text()).toBe("page");
	});

	it("keeps an existing Set-Cookie header", () => {
		const original = new Response(null, { status: 204, headers: { "set-cookie": "kept=1" } });
		const response = expireUnconsentedCookies(original, request("_fbp=3"), {});

		expect(response.headers.getSetCookie()).toContain("kept=1");
		expect(response.headers.getSetCookie()).toHaveLength(3);
	});

	it("uses the c15t cookie when no consent is given", () => {
		const response = expireUnconsentedCookies(
			new Response("page"),
			request(`c15t=${v3({ measurement: true, marketing: true })}; _ga=1; _fbp=2`),
		);

		expect(response.headers.getSetCookie()).toEqual([]);
	});

	it("returns the same response when there is nothing to expire", () => {
		const original = new Response("page");
		expect(expireUnconsentedCookies(original, request("session=abc"), {})).toBe(original);
	});
});
