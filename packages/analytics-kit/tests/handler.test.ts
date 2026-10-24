import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";

import { encodeToken } from "../src/codec.js";
import { type AnalyticsOptions, ProxyConfig, resolveOptions } from "../src/config.js";
import { handle, ResponseCache, routeOf, Upstreams } from "../src/handler.js";
import { encodedPrefix, loaderPath } from "../src/paths.js";

const origin = "https://site.example";
const loader = loaderPath("site.example");
const encodedPath = encodedPrefix("site.example");
const GTM_ID = "GTM-NTQ37T97";

const CONTAINER =
	'var h="https://www.googletagmanager.com/gtag/js";var b={"21":"www.googletagmanager.com"};';

interface Call {
	readonly path: string;
	readonly request: Request;
}

/** A fake upstream: records every call and answers with `respond`, or hangs when it returns "hang". */
function upstream(respond: (call: Call) => Response | "hang") {
	const calls: Call[] = [];
	const binding = {
		fetch: (request: Request): Promise<Response> => {
			const url = new URL(request.url);
			const call = { path: `${url.pathname}${url.search}`, request };
			calls.push(call);
			const result = respond(call);
			return result === "hang" ? new Promise<Response>(() => {}) : Promise.resolve(result);
		},
	};
	return { calls, binding };
}

type Fake = ReturnType<typeof upstream>;

function memoryCache() {
	const entries = new Map<string, Response>();
	const layer = Layer.succeed(ResponseCache, {
		get: (key) => Effect.sync(() => Option.fromNullishOr(entries.get(key)?.clone())),
		put: (key, response) => Effect.sync(() => void entries.set(key, response)),
	});
	return { entries, layer };
}

const script = (body = CONTAINER, headers: Record<string, string> = {}) =>
	new Response(body, { headers: { "content-type": "application/javascript", ...headers } });

interface Setup {
	readonly gtmId?: string | undefined;
	readonly sgtm?: Fake;
	readonly cache?: ReturnType<typeof memoryCache>;
}

/** Runs `handle` with the same services `createProxyHandler` assembles on a Worker. */
const runWith = (request: Request, setup: Setup) => {
	const options: AnalyticsOptions = {
		gtmId: setup.gtmId,
		sgtm: setup.sgtm?.binding,
	};
	const resolved = resolveOptions(options);
	const cache = setup.cache ?? memoryCache();
	return handle(request).pipe(
		Effect.provide(
			Layer.mergeAll(ProxyConfig.layer(resolved), Upstreams.layer(resolved.upstreams), cache.layer),
		),
	);
};

const run = (request: Request, sgtm?: Fake, cache = memoryCache()) =>
	runWith(request, { gtmId: GTM_ID, sgtm, cache });

const encoded = (plain: string) =>
	`${origin}${encodedPath}${encodeToken(plain, crypto.getRandomValues(new Uint8Array(4)))}`;

const status = (response: Option.Option<Response>) => Option.getOrThrow(response).status;

describe("routeOf", () => {
	it("names the proxy's own paths and leaves the site's alone", () => {
		const table: [string, string | null][] = [
			[loader, "loader"],
			[`${encodedPath}x`, "encoded"],
			["/_sgtm", "denied"],
			["/_sgtm/g/collect", "denied"],
			["/_op", null],
			["/_op/track", null],
			["/_op/op1.js", null],
			["/", null],
			["/blog", null],
			["/_sgtmx", null],
			["/x.js", null],
		];

		for (const [path, route] of table) {
			expect({ path, route: routeOf(new URL(`${origin}${path}`)) }).toEqual({ path, route });
		}
	});
});

describe("handle", () => {
	describe("loader", () => {
		it.effect("serves gtm.js with the shim in front, the sGTM prefix and hosts rewritten", () =>
			Effect.gen(function* () {
				const fake = upstream(() => script());
				const request = new Request(`${origin}${loader}?x=1`, {
					headers: { "cf-connecting-ip": "203.0.113.9" },
				});

				const response = Option.getOrThrow(yield* run(request, fake));
				const body = yield* Effect.promise(() => response.text());

				expect(fake.calls.map((call) => call.path)).toEqual([`/gtm.js?id=${GTM_ID}`]);
				expect(new Headers(fake.calls[0]!.request.headers).get("x-forwarded-for")).toBe(
					"203.0.113.9",
				);
				expect(body.startsWith("(function (window) {")).toBe(true);
				expect(body).toContain(JSON.stringify(encodedPath));
				expect(body).toContain(JSON.stringify(["/_sgtm/"]));
				expect(body).toContain('var h="https://site.example/_sgtm/gtag/js"');
				expect(body).toContain('"21":"site.example/_sgtm"');
				expect(body).not.toContain("googletagmanager.com");
				expect(response.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
				expect(response.headers.get("cache-control")).toBe("public, max-age=300");
			}),
		);

		it.effect("is cached per path, except for server-side previews", () =>
			Effect.gen(function* () {
				const fake = upstream(() => script());
				const cache = memoryCache();
				const target = `${origin}${loader}`;

				yield* run(new Request(`${target}?a=1`), fake, cache);
				const cached = yield* run(new Request(target), fake, cache);
				const preview = Option.getOrThrow(
					yield* run(
						new Request(target, { headers: { "x-gtm-server-preview": "abc" } }),
						fake,
						cache,
					),
				);

				expect(status(cached)).toBe(200);
				expect(preview.headers.get("cache-control")).toBe("no-store");
				expect(preview.headers.get("vary")).toBe("x-gtm-server-preview");
				expect([...cache.entries.keys()]).toEqual([target]);
				expect(fake.calls).toHaveLength(2);
			}),
		);

		it.effect("is not cached when sGTM sets cookies", () =>
			Effect.gen(function* () {
				const cache = memoryCache();
				yield* run(
					new Request(`${origin}${loader}`),
					upstream(() => script(CONTAINER, { "set-cookie": "FPID=1" })),
					cache,
				);
				expect(cache.entries.size).toBe(0);
			}),
		);

		it.effect("retries twice, then answers 502", () =>
			Effect.gen(function* () {
				const fake = upstream(() => new Response("down", { status: 503 }));
				const fiber = yield* Effect.forkChild(run(new Request(`${origin}${loader}`), fake));
				yield* TestClock.adjust("1 second");
				expect(status(yield* Fiber.join(fiber))).toBe(502);
				expect(fake.calls).toHaveLength(3);
			}),
		);

		it.effect("recovers when a retry succeeds", () =>
			Effect.gen(function* () {
				const fake = upstream(() =>
					fake.calls.length === 1 ? new Response("down", { status: 503 }) : script(),
				);
				const fiber = yield* Effect.forkChild(run(new Request(`${origin}${loader}`), fake));
				yield* TestClock.adjust("1 second");
				expect(status(yield* Fiber.join(fiber))).toBe(200);
				expect(fake.calls).toHaveLength(2);
			}),
		);

		it.effect("times out a body that never finishes", () =>
			Effect.gen(function* () {
				const fake = upstream(() => script(new ReadableStream() as unknown as string));
				const fiber = yield* Effect.forkChild(run(new Request(`${origin}${loader}`), fake));
				yield* TestClock.adjust("1 minute");
				expect(status(yield* Fiber.join(fiber))).toBe(502);
				expect(fake.calls).toHaveLength(3);
			}),
		);

		it.effect("passes a 4xx through uncached", () =>
			Effect.gen(function* () {
				const cache = memoryCache();
				const fake = upstream(() => new Response("no client", { status: 400 }));
				expect(status(yield* run(new Request(`${origin}${loader}`), fake, cache))).toBe(400);
				expect(fake.calls).toHaveLength(1);
				expect(cache.entries.size).toBe(0);
			}),
		);

		it.effect("serves an empty, uncached script when gtmId is missing", () =>
			Effect.gen(function* () {
				const fake = upstream(() => script());
				const response = Option.getOrThrow(
					yield* runWith(new Request(`${origin}${loader}`), { sgtm: fake }),
				);
				expect(response.status).toBe(200);
				expect(yield* Effect.promise(() => response.text())).toBe("");
				expect(response.headers.get("cache-control")).toBe("no-store");
				expect(fake.calls).toHaveLength(0);
			}),
		);

		it.effect("serves an empty, uncached script when sGTM is missing", () =>
			Effect.gen(function* () {
				const response = Option.getOrThrow(
					yield* runWith(new Request(`${origin}${loader}`), { gtmId: GTM_ID }),
				);
				expect(response.status).toBe(200);
				expect(yield* Effect.promise(() => response.text())).toBe("");
				expect(response.headers.get("cache-control")).toBe("no-store");
			}),
		);
	});

	describe("encoded requests", () => {
		it.effect(
			"forwards an sGTM hit once, without the prefix, with method, body and filtered headers",
			() =>
				Effect.gen(function* () {
					const fake = upstream(() => new Response(null, { status: 204 }));
					const request = new Request(encoded("/_sgtm/g/collect?v=2&en=page_view"), {
						method: "POST",
						body: "en=scroll",
						headers: {
							cookie: "_ga=1; session=secret",
							"cf-connecting-ip": "203.0.113.9",
							"cf-ipcountry": "CZ",
							"x-forwarded-for": "198.51.100.1",
						},
					});

					expect(status(yield* run(request, fake))).toBe(204);

					const [call] = fake.calls;
					const headers = new Headers(call!.request.headers);
					expect(call!.path).toBe("/g/collect?v=2&en=page_view");
					expect(call!.request.method).toBe("POST");
					expect(headers.get("cookie")).toBe("_ga=1");
					expect(headers.get("x-forwarded-for")).toBe("203.0.113.9");
					expect(headers.get("cf-ipcountry")).toBe("CZ");
					expect(yield* Effect.promise(() => call!.request.text())).toBe("en=scroll");
				}),
		);

		it.effect("answers 404 when sGTM is not configured", () =>
			Effect.gen(function* () {
				const response = yield* runWith(new Request(encoded("/_sgtm/g/collect")), {
					gtmId: GTM_ID,
				});
				expect(status(response)).toBe(404);
			}),
		);

		it.effect("answers 404 to a plain request under the prefix, without calling sGTM", () =>
			Effect.gen(function* () {
				const fake = upstream(() => new Response(null, { status: 204 }));
				expect(status(yield* run(new Request(`${origin}/_sgtm/g/collect?v=2`), fake))).toBe(404);
				expect(fake.calls).toHaveLength(0);
			}),
		);

		it.effect("refuses a token whose path would leave the upstream", () =>
			Effect.gen(function* () {
				const fake = upstream(() => script());
				expect(status(yield* run(new Request(encoded("/_sgtm//evil.example/x")), fake))).toBe(400);
				expect(fake.calls).toHaveLength(0);
			}),
		);

		it.effect("rewrites hosts in scripts the container loads itself", () =>
			Effect.gen(function* () {
				const fake = upstream(() => script());
				const response = Option.getOrThrow(
					yield* run(new Request(encoded("/_sgtm/gtag/js?id=G-X")), fake),
				);
				const body = yield* Effect.promise(() => response.text());
				expect(fake.calls[0]!.path).toBe("/gtag/js?id=G-X");
				expect(body).toBe(
					CONTAINER.replaceAll("https://www.googletagmanager.com", `${origin}/_sgtm`).replaceAll(
						"www.googletagmanager.com",
						"site.example/_sgtm",
					),
				);
			}),
		);

		it.effect("answers 400 when the token names an unknown prefix", () =>
			Effect.gen(function* () {
				const fake = upstream(() => script());
				expect(status(yield* run(new Request(encoded("/_nope/x")), fake))).toBe(400);
				expect(fake.calls).toHaveLength(0);
			}),
		);

		it.effect("answers 400 to a token the shim did not issue", () =>
			Effect.gen(function* () {
				const fake = upstream(() => script());
				const response = yield* run(new Request(`${origin}${encodedPath}garbage`), fake);
				expect(status(response)).toBe(400);
				expect(fake.calls).toHaveLength(0);
			}),
		);

		it.effect("answers 502 without retrying when sGTM hangs", () =>
			Effect.gen(function* () {
				const fake = upstream(() => "hang");
				const fiber = yield* Effect.forkChild(
					run(new Request(encoded("/_sgtm/g/collect?v=2")), fake),
				);
				yield* TestClock.adjust("5 seconds");
				expect(status(yield* Fiber.join(fiber))).toBe(502);
				expect(fake.calls).toHaveLength(1);
			}),
		);
	});
});
