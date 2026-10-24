import { describe, expect, it } from "@effect/vitest";

import type { C15tAstroOptions, Script } from "c15t/astro";

import { c15tPreset, gtmScript, gtmScripts, type GtmScriptOptions } from "../src/c15t.js";
import { loaderPath } from "../src/paths.js";

function script(options: GtmScriptOptions): Script {
	const result = gtmScript(options);
	if (result === undefined) throw new Error("expected a script");
	return result;
}

describe("c15tPreset", () => {
	it("offers our categories in offline mode", () => {
		const preset = c15tPreset() satisfies C15tAstroOptions;

		expect(preset.consentCategories).toEqual(["necessary", "measurement", "marketing"]);
		expect(preset.mode).toBeDefined();
		expect(preset.mode).toMatchObject({ type: "offline" });
	});

	it("stays plain JSON data", () => {
		const preset = c15tPreset();
		const parsed = JSON.parse(JSON.stringify(preset)) as {
			consentCategories?: string[];
			mode?: { type?: string };
		};

		expect(parsed.consentCategories).toEqual(["necessary", "measurement", "marketing"]);
		expect(parsed.mode?.type).toBe("offline");
	});

	it("lets a site override categories and keeps the mode", () => {
		const preset = c15tPreset({ consentCategories: ["necessary"] });

		expect(preset.consentCategories).toEqual(["necessary"]);
		expect(preset.mode).toMatchObject({ type: "offline" });
	});
});

describe("gtmScript", () => {
	const host = "www.example.com";

	it("points the container at our first-party loader", () => {
		const result = script({ host });

		expect(result.src).toBe(loaderPath(host));
		expect(result.src).not.toContain("googletagmanager.com");
		expect(result.id).toBe("google-tag-manager");
		expect(result.alwaysLoad).toBe(true);
		expect(typeof result.onBeforeLoad).toBe("function");
	});

	it("can wait for consent before loading", () => {
		const result = script({ host, loadMode: "after-consent" });

		expect(result.alwaysLoad).toBeUndefined();
		expect(result.persistAfterConsentRevoked).toBe(true);
		expect(result.category).toEqual({ or: ["measurement", "marketing"] });
	});

	it("is absent without a host, which is the server", () => {
		expect(gtmScript()).toBeUndefined();
		expect(gtmScripts()).toEqual([]);
	});

	it("wraps into the client entrypoint's script list", () => {
		const scripts = gtmScripts({ host });

		expect(scripts).toHaveLength(1);
		expect(scripts[0]?.src).toBe(loaderPath(host));
	});

	it("never puts a container id on the page", () => {
		const serialized = JSON.stringify({
			...gtmScript({ host }),
			onBeforeLoad: String(gtmScript({ host })?.onBeforeLoad),
		});
		const withRealId = JSON.stringify({
			...gtmScript({ host, id: "GTM-NTQ37T97" }),
			onBeforeLoad: String(gtmScript({ host })?.onBeforeLoad),
		});

		expect(serialized).not.toContain("GTM-");
		expect(withRealId).not.toContain("GTM-NTQ37T97");
		expect(serialized).toContain(loaderPath(host));
	});

	it("offers no dataLayer rename, which the loader would not follow", () => {
		// @ts-expect-error the loader serves gtm.js without `l=`
		const options: GtmScriptOptions = { host, dataLayer: "otherLayer" };
		expect(options.host).toBe(host);
	});
});
