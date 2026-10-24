import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";

import { analytics } from "../src/astro.js";

/** Every module `entry` imports, following relative imports. */
function importGraph(entry: URL, seen = new Map<string, string[]>()): Map<string, string[]> {
	if (seen.has(entry.href)) return seen;
	const specifiers = [...readFileSync(entry, "utf8").matchAll(/from\s+"([^"]+)"/g)].map(
		(match) => match[1]!,
	);
	seen.set(entry.href, specifiers);
	for (const specifier of specifiers) {
		if (specifier.startsWith(".")) {
			importGraph(new URL(specifier.replace(/\.js$/, ".ts"), entry), seen);
		}
	}
	return seen;
}

describe("@numoteq/analytics-kit/client", () => {
	it("imports nothing but its own files", () => {
		const imports = [...importGraph(new URL("../src/client.ts", import.meta.url)).values()].flat();
		expect(imports.filter((specifier) => !specifier.startsWith("."))).toEqual([]);
	});
});

interface VirtualPlugin {
	resolveId(id: string): string | undefined;
	load(id: string): string | undefined;
}

/** Runs the integration's setup hook and loads the middleware it registers. */
function setup(options?: Parameters<typeof analytics>[0]) {
	let middleware = { order: "", entrypoint: "" };
	let plugin: VirtualPlugin | undefined;
	const hook = analytics(options).hooks["astro:config:setup"] as (params: unknown) => void;
	hook({
		addMiddleware: (added: typeof middleware) => (middleware = added),
		updateConfig: (config: { vite: { plugins: VirtualPlugin[] } }) =>
			(plugin = config.vite.plugins[0]),
	});
	const resolved = plugin!.resolveId(middleware.entrypoint)!;
	return { order: middleware.order, resolved, source: plugin!.load(resolved)! };
}

describe("@numoteq/analytics-kit/astro", () => {
	it("adds generated middleware that runs before the site's own", () => {
		const { order, resolved, source } = setup();
		expect(order).toBe("pre");
		expect(resolved.startsWith("\0")).toBe(true);
		expect(source).toContain('import { env } from "cloudflare:workers";');
		expect(source).toContain('import { createAnalytics } from "@numoteq/analytics-kit";');
		expect(source).toContain('env["GTM_ID"]');
		expect(source).toContain('env["SGTM_UPSTREAM"]');
		expect(source).toContain("createAnalytics(");
		expect(source).toContain("client.handle(context.request)");
		expect(source).toContain("client.send(");
		expect(source).toContain("context.locals.cfContext?.waitUntil(sent)");
		expect(source).toContain("context.locals.analytics");
		expect(source).toContain("context.locals.c15t?.snapshot?.effectivePermissions");
	});

	it("reads overridden env names", () => {
		const { source } = setup({
			gtmIdVar: "WEB_GTM",
			sgtmBinding: "TAGGING",
		});
		expect(source).toContain('env["WEB_GTM"]');
		expect(source).toContain('env["TAGGING"]');
	});

	it("passes the event options through to the sender", () => {
		const { source } = setup();

		expect(source).toContain("{ name, params, ...options }");
	});

	it("creates the client once per isolate, for both halves", () => {
		const { source } = setup();

		expect(source).toContain("let instance;");
		expect(source).toContain("instance ??= createAnalytics(");
		expect(source.match(/createAnalytics\(/g)).toHaveLength(1);
	});

	it("passes server event options through", () => {
		const { source } = setup({
			serverEvents: {
				apiSecretVar: "MP_SECRET",
				path: "/mp/collect",
			},
		});
		expect(source).toContain('env["MP_SECRET"]');
		expect(source).toContain('"/mp/collect"');
	});
});
