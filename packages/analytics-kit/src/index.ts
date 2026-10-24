import { Effect, Layer, Logger, ManagedRuntime, Option, Result } from "effect";

import { ProxyConfig, resolveOptions, type AnalyticsOptions } from "./config.js";
import { handle as handleRequest, ResponseCache, Upstreams } from "./handler.js";
import {
	ServerEvents,
	promiseSender,
	resolveServerEventsOptions,
	type ServerEventsClient,
	type ServerEventsOptions,
} from "./server/send.js";

export type { AnalyticsOptions, UpstreamBinding, UpstreamInput } from "./config.js";
export { loaderPath, PREFIX, PREFIXES, SGTM_PREFIX } from "./paths.js";
export type { UpstreamName } from "./paths.js";
export {
	createServerEvents,
	gcsOf,
	RequestContext,
	resolveServerEventsOptions,
	ServerEventRejected,
	ServerEvents,
	ServerEventUnavailable,
} from "./server/index.js";
export type {
	Consent,
	ConsentCategory,
	ServerEvent,
	ServerEventsClient,
	ServerEventsOptions,
	ServerEventsSettings,
} from "./server/index.js";

/** Answers the proxy's own requests; `null` means the request belongs to the site. */
export type ProxyHandler = (request: Request) => Promise<Response | null>;

/** Server events as the Astro adapter configures them; the upstream comes from `sgtm`. */
export type AnalyticsServerEventsOptions = Omit<ServerEventsOptions, "upstream">;

export interface AnalyticsClientOptions extends AnalyticsOptions {
	/** Measurement Protocol settings, or `false` for a site that only proxies. */
	readonly serverEvents?: AnalyticsServerEventsOptions | false;
}

/** Both halves on one runtime: the proxy, and the sender for server-originated events. */
export interface AnalyticsClient {
	readonly handle: ProxyHandler;
	readonly send: ServerEventsClient["send"];
}

type ProxyServices = ProxyConfig | Upstreams | ResponseCache;
type AnalyticsRuntime<R> = ManagedRuntime.ManagedRuntime<R, never>;

const logger = Logger.layer([Logger.consoleJson]);

/** Answers the proxy's paths, and nothing at all once the browser is gone. */
const proxyHandler =
	(runtime: AnalyticsRuntime<ProxyServices>): ProxyHandler =>
	async (request) => {
		// The browser is gone before we started: no upstream call is worth making.
		if (request.signal.aborted) return new Response(null, { status: 204 });
		try {
			return await runtime.runPromise(handleRequest(request).pipe(Effect.map(Option.getOrNull)), {
				signal: request.signal,
			});
		} catch (cause) {
			// The browser is gone: answer nothing and skip the work the site would render.
			if (request.signal.aborted) return new Response(null, { status: 204 });
			throw cause;
		}
	};

/**
 * The proxy and the sender on one runtime, which is what the Astro integration uses. A part with
 * missing or invalid options logs why once and turns itself off: the loader then serves an empty
 * script and the prefix answers 404, so one build serves production, previews and local development.
 */
export function createAnalytics(options: AnalyticsClientOptions): AnalyticsClient {
	const { serverEvents = {}, ...proxy } = options;
	const resolved = resolveOptions(proxy);
	const events =
		serverEvents === false
			? undefined
			: resolveServerEventsOptions({ ...serverEvents, upstream: proxy.sgtm }, "sgtm");

	const warnings = [
		...resolved.warnings,
		...(events !== undefined && Result.isFailure(events)
			? [`server events off: ${events.failure}`]
			: []),
	];
	const settings = events !== undefined && Result.isSuccess(events) ? events.success : undefined;

	const proxyLayers = Layer.mergeAll(
		ProxyConfig.layer(resolved),
		Upstreams.layer(resolved.upstreams),
		ResponseCache.workers,
	);
	const logWarnings = <R>(runtime: AnalyticsRuntime<R>) => {
		if (warnings.length > 0) {
			runtime.runSync(Effect.logWarning(`analytics: ${warnings.join("; ")}`));
		}
	};

	if (settings === undefined) {
		const runtime = ManagedRuntime.make(Layer.mergeAll(proxyLayers, logger));
		logWarnings(runtime);
		return { handle: proxyHandler(runtime), send: () => Promise.resolve() };
	}

	const runtime = ManagedRuntime.make(
		Layer.mergeAll(proxyLayers, ServerEvents.layer(settings), logger),
	);
	logWarnings(runtime);
	return {
		handle: proxyHandler(runtime),
		send: promiseSender(runtime),
	};
}

/** Only the proxy, for a framework that serves it itself. */
export function createProxyHandler(options: AnalyticsOptions): ProxyHandler {
	return createAnalytics({ ...options, serverEvents: false }).handle;
}
