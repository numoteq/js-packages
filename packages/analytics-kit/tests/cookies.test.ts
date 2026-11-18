import { describe, expect, it } from "@effect/vitest";

import {
	consentOfHit,
	expireUnconsentedCookies,
	expiredCookieHeaders,
	registrableDomain,
	storageOf,
} from "../src/cookies.js";
import { MARKETING_COOKIE_PATTERNS, MEASUREMENT_COOKIE_PATTERNS } from "../src/rewrite.js";

const HOST = "www.example.com";
const EXPIRES = "Thu, 01 Jan 1970 00:00:00 GMT";

const expiry = (name: string, domain?: string) =>
	`${name}=; Path=/; Max-Age=0; Expires=${EXPIRES}${domain === undefined ? "" : `; Domain=${domain}`}`;

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

describe("consentOfHit", () => {
	const granted = { measurement: true, marketing: true };

	it("reads gcs from the hit's query", () => {
		expect(consentOfHit("/g/collect?id=G-1&gcs=G100")).toEqual({
			measurement: false,
			marketing: false,
		});
		expect(consentOfHit("/g/collect?gcs=G111")).toEqual(granted);
		expect(consentOfHit("/g/collect?gcs=G101")).toEqual({
			measurement: true,
			marketing: false,
		});
	});

	it("reads gcs from a POST body", () => {
		const body = new TextEncoder().encode("v=2&gcs=G110&sid=1");

		expect(consentOfHit("/g/collect", body)).toEqual({ measurement: false, marketing: true });
	});

	it("grants both when the hit carries no gcs it can read", () => {
		expect(consentOfHit("/g/collect")).toEqual(granted);
		expect(consentOfHit("/g/collect?gcs=G1--")).toEqual(granted);
		expect(consentOfHit("/g/collect?gcs=nonsense")).toEqual(granted);
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

	it("keeps the cookies the visitor allowed", () => {
		const response = expireUnconsentedCookies(new Response("page"), request("_ga=1; _fbp=2"), {
			measurement: true,
			marketing: true,
		});

		expect(response.headers.getSetCookie()).toEqual([]);
	});

	it("returns the same response when there is nothing to expire", () => {
		const original = new Response("page");
		expect(expireUnconsentedCookies(original, request("session=abc"), {})).toBe(original);
	});
});
