import { describe, expect, it } from "@effect/vitest";

import fixture from "./fixtures/gtm-excerpt.js.txt?raw";

import {
	consentedCookies,
	filterCookies,
	rebuildResponse,
	rewriteGtmHosts,
	upstreamHeaders,
} from "../src/rewrite.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const site = { origin: "https://site.example", host: "site.example", prefix: "/_sgtm" };

const rewrite = (text: string) => decoder.decode(rewriteGtmHosts(encoder.encode(text), site));

describe("rewriteGtmHosts", () => {
	it("points every container host in a real gtm.js excerpt at the site", () => {
		expect(fixture.match(/www\.googletagmanager\.com/g)).toHaveLength(7);

		const output = rewrite(fixture);

		expect(output).not.toContain("www.googletagmanager.com");
		expect(output).toContain('"21":"site.example/_sgtm"');
		expect(output).toContain('a="https://site.example/_sgtm/static/service_worker/"');
	});

	it("keeps the escaped hostname check and third-party endpoints", () => {
		const output = rewrite(fixture);
		expect(output).toContain("/(^|\\.)googletagmanager\\.com$/.test(b)");
		expect(output).toContain("https://www.google-analytics.com/g/collect");
		expect(output).toContain("https://www.facebook.com/tr/");
	});

	it("returns the input unchanged when there is nothing to rewrite", () => {
		const source = encoder.encode("var a=1;");
		expect(rewriteGtmHosts(source, site)).toBe(source);
	});
});

describe("filterCookies", () => {
	it("keeps only analytics and first-party GTM cookies", () => {
		expect(
			filterCookies("_ga=GA1.1.1; session=secret; _ga_ABC=GS1; FPID=x; _fbp=fb; cf_clearance=y"),
		).toBe("_ga=GA1.1.1; _ga_ABC=GS1; FPID=x; _fbp=fb");
		expect(filterCookies(null)).toBe("");
	});
});

describe("consentedCookies", () => {
	const header = "_ga=GA1.1.1; _ga_ABC=GS1; FPID=x; _gcl_au=1; _gac_X=2; _fbp=fb; session=secret";

	it("splits the allowed cookies into analytics and ad storage", () => {
		expect(consentedCookies(header, { analytics: true, ads: false })).toBe(
			"_ga=GA1.1.1; _ga_ABC=GS1; FPID=x",
		);
		expect(consentedCookies(header, { analytics: false, ads: true })).toBe(
			"_gcl_au=1; _gac_X=2; _fbp=fb",
		);
		expect(consentedCookies(header, { analytics: false, ads: false })).toBe("");
		expect(consentedCookies(undefined, { analytics: true, ads: true })).toBe("");
	});
});

describe("upstreamHeaders", () => {
	it("keeps every forwarded header and only the analytics cookies for sGTM", () => {
		const request = new Request("https://site.example/_sgtm/x", {
			headers: {
				"cf-ray": "1",
				"cf-ipcountry": "CZ",
				"cf-connecting-ip": "203.0.113.9",
				cookie: "_ga=1; session=secret",
				"x-forwarded-for": "198.51.100.1",
				"user-agent": "test",
				authorization: "Bearer secret",
			},
		});

		const headers = upstreamHeaders(request, "203.0.113.9");

		expect(Object.fromEntries(headers)).toEqual({
			"cf-ray": "1",
			"cf-ipcountry": "CZ",
			"cf-connecting-ip": "203.0.113.9",
			cookie: "_ga=1",
			"user-agent": "test",
			"x-forwarded-for": "203.0.113.9",
			"x-forwarded-host": "site.example",
			"x-forwarded-proto": "https",
		});
	});

	it("does not invent an address, and forwards no spoofed one", () => {
		const request = new Request("https://site.example/_sgtm/g/collect", {
			headers: { "x-forwarded-for": "5.6.7.8" },
		});

		const headers = upstreamHeaders(request, undefined);

		expect(headers.has("x-forwarded-for")).toBe(false);
		expect(headers.get("x-forwarded-host")).toBe("site.example");
	});
});

describe("rebuildResponse", () => {
	it("keeps status and every Set-Cookie, drops headers of the old body", async () => {
		const upstream = new Response("old", {
			status: 201,
			headers: [
				["set-cookie", "a=1"],
				["set-cookie", "b=2"],
				["content-length", "3"],
				["etag", '"x"'],
				["x-kept", "yes"],
			],
		});

		const response = rebuildResponse(upstream, encoder.encode("new body"), { "x-added": "1" });

		expect(response.status).toBe(201);
		expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
		expect(response.headers.get("etag")).toBeNull();
		expect(response.headers.get("x-kept")).toBe("yes");
		expect(response.headers.get("x-added")).toBe("1");
		expect(await response.text()).toBe("new body");
	});
});
