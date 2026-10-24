import type { AstroIntegration } from "astro";

export interface ServerEventsAstroOptions {
	/** Path of the Measurement Protocol client. Default `/mp/collect`. */
	readonly path?: string;
}

export interface AnalyticsAstroOptions {
	/** Worker var with the id of the web container (`GTM-…`). Default `GTM_ID`. */
	readonly gtmIdVar?: string;
	/** Workers VPC or service binding that reaches sGTM. Default `SGTM_UPSTREAM`. */
	readonly sgtmBinding?: string;
	readonly serverEvents?: ServerEventsAstroOptions;
}

/** Plain values the sender hashes before they leave the Worker. */
export interface ServerEventUser {
	readonly email?: string;
	readonly phone?: string;
}

export interface ServerEventOptions {
	/** E-mail and phone, hashed here and sent only with marketing consent. */
	readonly user?: ServerEventUser;
	/** Defaults to the page the visitor came from (`Referer`). */
	readonly pageLocation?: string;
}

/** What `locals.analytics` offers a page, an action or an API route. */
export interface AnalyticsLocals {
	/**
	 * Sends a server-originated event through our sGTM in the background. Returns the promise so a
	 * test can await it; the response does not wait for it, and it never throws.
	 */
	event(
		name: string,
		params?: Readonly<Record<string, unknown>>,
		options?: ServerEventOptions,
	): Promise<void>;
}

declare global {
	namespace App {
		interface Locals {
			analytics: AnalyticsLocals;
		}
	}
}

const MIDDLEWARE_ID = "virtual:@numoteq/analytics-kit/middleware";

/**
 * The middleware is generated, so `cloudflare:workers` is only imported by the site's own build.
 * The client is created on the first request, where the env is guaranteed to exist and one isolate
 * keeps one of it: the proxy and the sender share a single runtime.
 */
function middlewareSource(
	gtmIdVar: string,
	sgtmBinding: string,
	serverEvents: ServerEventsAstroOptions,
): string {
	return `import { env } from "cloudflare:workers";
import { createAnalytics } from "@numoteq/analytics-kit";

let instance;

function getClient() {
	instance ??= createAnalytics({
		gtmId: env[${JSON.stringify(gtmIdVar)}],
		sgtm: env[${JSON.stringify(sgtmBinding)}],
		serverEvents: { path: ${JSON.stringify(serverEvents.path ?? "/mp/collect")} },
	});
	return instance;
}

export async function onRequest(context, next) {
	const client = getClient();
	const handled = await client.handle(context.request);
	if (handled) return handled;

	// Consent is read per event: c15t's middleware runs after this one, so nothing is in
	// \`locals.c15t\` yet when the client is built.
	context.locals.analytics = {
		event(name, params, options) {
			const sent = client.send(
				context.request,
				{ name, params, ...options },
				context.locals.c15t?.snapshot?.effectivePermissions ?? {},
			);
			context.locals.cfContext?.waitUntil(sent);
			return sent;
		},
	};

	return next();
}
`;
}

/**
 * Serves the proxy from Astro middleware that runs before every other middleware, and puts
 * `locals.analytics` on the request. The container ids and bindings are read from the Worker env
 * at runtime, so one build serves every environment; without them the matching part is off.
 */
export function analytics(options: AnalyticsAstroOptions = {}): AstroIntegration {
	const source = middlewareSource(
		options.gtmIdVar ?? "GTM_ID",
		options.sgtmBinding ?? "SGTM_UPSTREAM",
		options.serverEvents ?? {},
	);
	return {
		name: "@numoteq/analytics-kit",
		hooks: {
			"astro:config:setup": ({ addMiddleware, updateConfig }) => {
				updateConfig({
					vite: {
						plugins: [
							{
								name: "@numoteq/analytics-kit",
								resolveId: (id) => (id === MIDDLEWARE_ID ? `\0${MIDDLEWARE_ID}` : undefined),
								load: (id) => (id === `\0${MIDDLEWARE_ID}` ? source : undefined),
							},
						],
					},
				});
				addMiddleware({ order: "pre", entrypoint: MIDDLEWARE_ID });
			},
		},
	};
}
