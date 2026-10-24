import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect";

import { decodeToken } from "./codec.js";
import { ProxyConfig, type UpstreamBinding } from "./config.js";
import {
	encodedPrefix,
	loaderPath,
	matchPrefix,
	PREFIXES,
	SGTM_PREFIX,
	type UpstreamName,
} from "./paths.js";
import {
	concatBytes,
	isJavaScript,
	rebuildResponse,
	rewriteGtmHosts,
	upstreamHeaders,
} from "./rewrite.js";
import { renderShim } from "./shim.js";
import { callUpstream } from "./upstream.js";

const encoder = new TextEncoder();

const LOADER_TIMEOUT = Duration.seconds(10);
const REQUEST_TIMEOUT = Duration.seconds(5);
const CACHE_TTL_SECONDS = 300;

/** sGTM did not answer in time or could not be reached. */
export class UpstreamUnavailable extends Schema.TaggedError<UpstreamUnavailable>()(
	"UpstreamUnavailable",
	{ reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** The encoded path segment is not a token the shim issued, or names no forwarded upstream. */
export class InvalidToken extends Schema.TaggedError<InvalidToken>()("InvalidToken", {}) {}

/** One upstream, reached through a binding or a base URL. */
export interface UpstreamClient {
	readonly fetch: (path: string, init: RequestInit) => Effect.Effect<Response, UpstreamUnavailable>;
}

/** The configured upstreams. A prefix without one answers 404. */
export class Upstreams extends Context.Service<
	Upstreams,
	{ readonly get: (name: UpstreamName) => Option.Option<UpstreamClient> }
>()("@numoteq/analytics-kit-kit/upstreams") {
	static layer(
		upstreams: Partial<Record<UpstreamName, UpstreamBinding | URL>>,
	): Layer.Layer<Upstreams> {
		const clients = new Map<UpstreamName, UpstreamClient>();
		for (const [name, upstream] of Object.entries(upstreams) as [
			UpstreamName,
			UpstreamBinding | URL,
		][]) {
			clients.set(name, {
				fetch: (path, init) =>
					Effect.tryPromise({
						try: (signal) => callUpstream(upstream, path, { ...init, signal }),
						catch: (cause) => new UpstreamUnavailable({ reason: `${name} fetch failed`, cause }),
					}),
			});
		}
		return Layer.succeed(Upstreams, { get: (name) => Option.fromNullishOr(clients.get(name)) });
	}
}

/** Shared cache for the assembled loader. */
export class ResponseCache extends Context.Service<
	ResponseCache,
	{
		readonly get: (key: string) => Effect.Effect<Option.Option<Response>>;
		readonly put: (key: string, response: Response) => Effect.Effect<void>;
	}
>()("@numoteq/analytics-kit-kit/response-cache") {
	/** The Workers Cache API; a no-op where it does not exist. Failures only cost a cache miss. */
	static readonly workers: Layer.Layer<ResponseCache> = Layer.sync(ResponseCache, () => {
		const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
		return {
			get: (key) =>
				cache
					? Effect.tryPromise(() => cache.match(key)).pipe(
							Effect.map(Option.fromNullishOr),
							Effect.orElseSucceed(() => Option.none()),
						)
					: Effect.succeedNone,
			put: (key, response) =>
				cache ? Effect.tryPromise(() => cache.put(key, response)).pipe(Effect.ignore) : Effect.void,
		};
	});
}

export type Route = "loader" | "encoded" | "denied";

/** Which of the proxy's paths `url` is, or `null` when the request belongs to the site. */
export function routeOf(url: URL): Route | null {
	if (url.pathname === loaderPath(url.host)) return "loader";
	if (url.pathname.startsWith(encodedPrefix(url.host))) return "encoded";
	if (PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
		return "denied";
	}
	return null;
}

const empty = (status: number) => new Response(null, { status });

/** Without sGTM the loader is an empty script, so pages load quietly. */
const emptyLoader = () =>
	new Response("", {
		headers: {
			"content-type": "application/javascript; charset=utf-8",
			"cache-control": "no-store",
		},
	});

const timeout = (duration: Duration.Duration) =>
	Effect.timeoutOrElse({
		duration,
		orElse: () => Effect.fail(new UpstreamUnavailable({ reason: "timeout" })),
	});

const readBody = (response: Response) =>
	Effect.tryPromise({
		try: () => response.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
		catch: (cause) => new UpstreamUnavailable({ reason: "body read failed", cause }),
	});

/** Rewrites script hosts so the container loads its dependencies first-party; `shim` goes in front. */
const rewriteScript = (
	request: Request,
	response: Response,
	options: { shim?: string; cache?: boolean } = {},
) =>
	readBody(response).pipe(
		Effect.map((bytes) => {
			const url = new URL(request.url);
			const body = rewriteGtmHosts(bytes, {
				origin: url.origin,
				host: url.host,
				prefix: SGTM_PREFIX,
			});
			if (options.shim === undefined) return rebuildResponse(response, body);
			return rebuildResponse(response, concatBytes([encoder.encode(options.shim), body]), {
				"content-type": "application/javascript; charset=utf-8",
				// A server-side preview must not be cached by anything, the Cache API nor an edge.
				"cache-control":
					options.cache === false ? "no-store" : `public, max-age=${CACHE_TTL_SECONDS}`,
				...(options.cache === false ? { vary: "x-gtm-server-preview" } : {}),
			});
		}),
	);

/**
 * gtm.js with the shim in front. Retried, because loading it twice is harmless; cached unless the
 * request is a server-side preview or sGTM sets cookies on it.
 */
const serveLoader = Effect.fn("analytics.loader")(function* (
	request: Request,
	clientIp: string | undefined,
) {
	const { gtmId } = yield* ProxyConfig;
	const upstreams = yield* Upstreams;
	const cache = yield* ResponseCache;

	const upstream = Option.getOrUndefined(upstreams.get("sgtm"));
	if (gtmId === undefined || upstream === undefined) return emptyLoader();

	const url = new URL(request.url);
	const key = new URL(url.pathname, url).href;
	const cacheable = !request.headers.has("x-gtm-server-preview");

	if (cacheable) {
		const cached = yield* cache.get(key);
		if (Option.isSome(cached)) {
			yield* Effect.annotateCurrentSpan("analytics.cache", "hit");
			return cached.value;
		}
	}

	const loader = yield* Effect.gen(function* () {
		const answer = yield* upstream
			.fetch(`/gtm.js?id=${encodeURIComponent(gtmId)}`, {
				headers: upstreamHeaders(request, clientIp),
				redirect: "manual",
			})
			.pipe(
				Effect.filterOrFail(
					(response) => response.status < 500,
					(response) => new UpstreamUnavailable({ reason: `HTTP ${response.status}` }),
				),
			);
		if (!answer.ok || !isJavaScript(answer)) return answer;
		return yield* rewriteScript(request, answer, {
			shim: renderShim(encodedPrefix(url.host)),
			cache: cacheable,
		});
	}).pipe(
		// The timeout covers the body read too, not just the response headers.
		timeout(LOADER_TIMEOUT),
		Effect.retry({ times: 2, schedule: Schedule.exponential("200 millis") }),
	);

	if (cacheable && loader.ok && isJavaScript(loader) && !loader.headers.has("set-cookie")) {
		yield* Effect.annotateCurrentSpan("analytics.cache", "miss");
		yield* cache.put(key, loader.clone());
	}
	return loader;
});

/** A decoded browser request, forwarded once: retrying a hit could count it twice. */
const forwardEncoded = Effect.fn("analytics.forward")(function* (
	request: Request,
	clientIp: string | undefined,
) {
	const upstreams = yield* Upstreams;
	const url = new URL(request.url);
	const target = decodeToken(url.pathname.slice(encodedPrefix(url.host).length));
	if (target === null) return yield* new InvalidToken();

	const matched = matchPrefix(target);
	if (matched === null) return yield* new InvalidToken();

	const upstream = Option.getOrUndefined(upstreams.get(matched.name));
	if (upstream === undefined) return empty(404);

	const hasBody = request.method !== "GET" && request.method !== "HEAD";
	return yield* Effect.gen(function* () {
		const answer = yield* upstream.fetch(matched.path, {
			method: request.method,
			headers: upstreamHeaders(request, clientIp),
			body: hasBody ? request.body : null,
			redirect: "manual",
			...(hasBody ? { duplex: "half" } : {}),
		});
		// Scripts the container loads itself, such as gtag.js, need their hosts rewritten too.
		if (answer.ok && isJavaScript(answer)) {
			return yield* rewriteScript(request, answer);
		}
		return answer;
	}).pipe(timeout(REQUEST_TIMEOUT));
});

/**
 * Answers the loader, encoded requests and everything else under the sGTM prefix (404: the shim
 * never sends plain data requests). `None` means the request belongs to the site.
 */
export const handle = (request: Request) => {
	const route = routeOf(new URL(request.url));
	if (route === null) return Effect.succeedNone;
	const clientIp = request.headers.get("cf-connecting-ip") ?? undefined;

	const routed: Effect.Effect<
		Response,
		UpstreamUnavailable | InvalidToken,
		ProxyConfig | Upstreams | ResponseCache
	> =
		route === "loader"
			? serveLoader(request, clientIp)
			: route === "encoded"
				? forwardEncoded(request, clientIp)
				: Effect.succeed(empty(404));

	return routed.pipe(
		Effect.catchTags({
			InvalidToken: () => Effect.succeed(empty(400)),
			UpstreamUnavailable: (error) =>
				Effect.logWarning(`analytics upstream unavailable: ${error.reason}`).pipe(
					Effect.annotateLogs({
						route,
						cause: error.cause === undefined ? undefined : String(error.cause),
					}),
					Effect.as(empty(502)),
				),
		}),
		Effect.map(Option.some),
		Effect.withSpan("analytics.request", { attributes: { "analytics.route": route } }),
	);
};
