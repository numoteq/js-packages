import {
	Cause,
	Clock,
	Context,
	Duration,
	Effect,
	Layer,
	Logger,
	ManagedRuntime,
	Result,
	Schema,
} from "effect";

import { consentedCookies } from "../rewrite.js";
import { decodePart, optionalPart, Upstream } from "../schema.js";
import { callUpstream, toTarget, type UpstreamInput, type UpstreamTarget } from "../upstream.js";
import { RequestContext, type Consent } from "./context.js";

/** The path of the Measurement Protocol client in the server container. */
const DEFAULT_PATH = "/mp/collect";
const DEFAULT_TIMEOUT = Duration.seconds(5);

const ClientPath = Schema.String.check(
	Schema.makeFilter((value) => value.startsWith("/") && !value.startsWith("//"), {
		expected: "a path starting with a single /",
	}),
);

/** One server-originated event. Enrichment from the request is added by the sender. */
export interface ServerEvent {
	readonly name: string;
	readonly params?: Readonly<Record<string, unknown>> | undefined;
	/**
	 * Plain values, hashed here before they leave the Worker. Sent only with marketing consent:
	 * the helper never sends an e-mail or a phone number as it got it, nor keeps a hashed profile
	 * of a visitor who did not allow it.
	 */
	readonly user?: { readonly email?: string; readonly phone?: string } | undefined;
	/** Defaults to the page the visitor came from (`Referer`). */
	readonly pageLocation?: string | undefined;
}

export interface ServerEventsOptions {
	/** Server-side GTM, the same binding the proxy uses. */
	readonly upstream?: UpstreamInput | undefined;
	/** Path of the Measurement Protocol client. Default `/mp/collect`. */
	readonly path?: string | undefined;
	/** Passed through as `api_secret`. The self-hosted container accepts any value itself. */
	readonly apiSecret?: string | undefined;
	readonly timeout?: Duration.Duration | undefined;
}

/** Resolved options, what the sender needs. */
export interface ServerEventsSettings {
	readonly target: UpstreamTarget;
	readonly path: string;
	readonly apiSecret?: string | undefined;
	readonly timeout: Duration.Duration;
}

/** sGTM answered, but the container refused the hit (4xx/5xx): nothing downstream saw it. */
export class ServerEventRejected extends Schema.TaggedError<ServerEventRejected>()(
	"ServerEventRejected",
	{ status: Schema.Number, detail: Schema.String },
) {}

/** sGTM could not be reached or did not answer in time. */
export class ServerEventUnavailable extends Schema.TaggedError<ServerEventUnavailable>()(
	"ServerEventUnavailable",
	{ reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/**
 * Server tags read consent from `x-ga-gcs` (the `G1` + ad + analytics triple), never from the MP
 * body's `consent` object, so the sender passes it as the `gcs` query parameter. Missing consent
 * counts as denied.
 */
export function gcsOf(consent: Consent): string {
	return `G1${consent.marketing === true ? "1" : "0"}${consent.measurement === true ? "1" : "0"}`;
}

async function hash(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** E-mail lowercased, phone reduced to digits, both SHA-256 in lowercase hex, as all vendors want. */
async function userDataOf(user: ServerEvent["user"]): Promise<Record<string, string> | undefined> {
	if (user === undefined) return undefined;
	const data: Record<string, string> = {};
	const email = user.email?.trim().toLowerCase();
	if (email) data["sha256_email_address"] = await hash(email);
	const phone = user.phone?.replace(/\D/g, "");
	if (phone) data["sha256_phone_number"] = await hash(phone);
	return Object.keys(data).length === 0 ? undefined : data;
}

/** The promise of hashes, which needs Web Crypto; a platform without it is a typed failure. */
const hashUser = (user: ServerEvent["user"]) =>
	user === undefined
		? Effect.succeed<Record<string, string> | undefined>(undefined)
		: Effect.tryPromise({
				try: () => userDataOf(user),
				catch: (cause) => new ServerEventUnavailable({ reason: "hashing failed", cause }),
			});

/**
 * The Measurement Protocol body. `page_location` describes the visit; `client_id`, `_fbp`/`_fbc`
 * and `user_data` are the visitor's identifiers. They travel only with the consent they belong
 * to: analytics storage for the GA cookies, marketing for the Meta ones and for the hashes,
 * because a hashed e-mail is still personal data.
 */
const payloadOf = (context: RequestContext, event: ServerEvent) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		const marketing = context.consent.marketing === true;

		const measurement = context.consent.measurement === true;
		const params: Record<string, unknown> = { ...event.params };
		// Params of the event must not smuggle an identifier past the consent checks below.
		delete params["session_id"];
		delete params["_fbp"];
		delete params["_fbc"];

		const pageLocation = event.pageLocation ?? context.pageLocation;
		if (pageLocation !== undefined) params["page_location"] = pageLocation;
		if (marketing) {
			if (context.fbp !== undefined) params["_fbp"] = context.fbp;
			if (context.fbc !== undefined) params["_fbc"] = context.fbc;
		}

		const userData = marketing ? yield* hashUser(event.user) : undefined;

		return {
			// The cookies of analytics storage: a stale `_ga` after a withdrawal is not consent.
			client_id: (measurement ? context.clientId : undefined) ?? crypto.randomUUID(),
			timestamp_micros: now * 1000,
			events: [{ name: event.name, params }],
			consent: {
				ad_user_data: marketing ? "GRANTED" : "DENIED",
				ad_personalization: marketing ? "GRANTED" : "DENIED",
			},
			...(userData === undefined ? {} : { user_data: userData }),
			...(context.ip === undefined ? {} : { ip_override: context.ip }),
			...(context.userAgent === undefined ? {} : { user_agent: context.userAgent }),
		};
	});

function queryOf(settings: ServerEventsSettings, context: RequestContext): string {
	const query = new URLSearchParams();
	if (settings.apiSecret) query.set("api_secret", settings.apiSecret);
	query.set("gcs", gcsOf(context.consent));
	return query.toString();
}

/**
 * The visitor's address, browser and consented cookies as headers too, the way the proxy forwards
 * a browser hit, so sGTM tags read them alike whatever the Measurement Protocol client maps.
 */
function headersOf(context: RequestContext): Record<string, string> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (context.ip !== undefined) headers["x-forwarded-for"] = context.ip;
	if (context.userAgent !== undefined) headers["user-agent"] = context.userAgent;
	const cookie = consentedCookies(context.cookie, {
		analytics: context.consent.measurement === true,
		ads: context.consent.marketing === true,
	});
	if (cookie !== "") headers["cookie"] = cookie;
	return headers;
}

const timeout = (duration: Duration.Duration) =>
	Effect.timeoutOrElse({
		duration,
		orElse: () => Effect.fail(new ServerEventUnavailable({ reason: "timeout" })),
	});

/** Builds and sends one hit. Sent once: no vendor downstream deduplicates a repeated event. */
const requestOf = Effect.fn("analytics.serverEvent")(function* (
	settings: ServerEventsSettings,
	context: RequestContext,
	event: ServerEvent,
) {
	const body = yield* payloadOf(context, event);
	const path = `${settings.path}?${queryOf(settings, context)}`;
	// The timeout covers reading a refusal's body too, not just the response headers.
	const refusal = yield* Effect.tryPromise({
		try: async (signal) => {
			const response = await callUpstream(settings.target, path, {
				method: "POST",
				headers: headersOf(context),
				body: JSON.stringify(body),
				signal,
			});
			if (response.ok) return undefined;
			return { status: response.status, detail: await response.text().catch(() => "") };
		},
		catch: (cause) => new ServerEventUnavailable({ reason: "sgtm fetch failed", cause }),
	}).pipe(timeout(settings.timeout));

	if (refusal === undefined) return;
	return yield* new ServerEventRejected({
		status: refusal.status,
		detail: refusal.detail.slice(0, 200),
	});
});

/** Sends server-originated events to the Measurement Protocol client of our sGTM. */
export class ServerEvents extends Context.Service<
	ServerEvents,
	{
		readonly send: (
			context: RequestContext,
			event: ServerEvent,
		) => Effect.Effect<void, ServerEventRejected | ServerEventUnavailable>;
	}
>()("@numoteq/analytics-kit-kit/server-events") {
	static layer(settings: ServerEventsSettings): Layer.Layer<ServerEvents> {
		return Layer.succeed(ServerEvents, {
			send: (context, event) => requestOf(settings, context, event),
		});
	}
}

/**
 * Validates the options; the failure is a readable description of what is missing or wrong.
 * `label` names the upstream in that message: the proxy says `sgtm`, a standalone sender `upstream`.
 */
export function resolveServerEventsOptions(
	options: ServerEventsOptions = {},
	label = "upstream",
): Result.Result<ServerEventsSettings, string> {
	const upstream = decodePart(Upstream, options.upstream, label, "no event is sent");
	const path = optionalPart(ClientPath, options.path, "path", "no event is sent");

	if (Result.isFailure(upstream)) return Result.fail(upstream.failure);
	if (Result.isFailure(path)) return Result.fail(path.failure);
	return Result.succeed({
		target: toTarget(upstream.success),
		path: path.success ?? DEFAULT_PATH,
		apiSecret: options.apiSecret,
		timeout: options.timeout ?? DEFAULT_TIMEOUT,
	});
}

/** The promise face of the sender: reads the request, sends, never throws. */
export interface ServerEventsClient {
	send(request: Request, event: ServerEvent, consent?: Consent): Promise<void>;
}

/**
 * `ServerEvents.send` for code outside Effect: reads the request, sends, logs a failure and
 * resolves. Shared by `createServerEvents` and the combined client.
 */
export const promiseSender =
	(runtime: ManagedRuntime.ManagedRuntime<ServerEvents, never>): ServerEventsClient["send"] =>
	(request, event, consent) =>
		runtime.runPromise(
			ServerEvents.use((events) =>
				events.send(RequestContext.fromRequest(request, consent), event),
			).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning(`analytics server event dropped: ${Cause.pretty(cause)}`),
				),
			),
		);

const logger = Logger.layer([Logger.consoleJson]);

/**
 * Creates the sender for code outside Effect, such as an Astro action or an API route. Without
 * an upstream it logs why once and drops events; a failed event is logged, never thrown, so a
 * page render or a form submit does not depend on analytics.
 */
export function createServerEvents(options: ServerEventsOptions = {}): ServerEventsClient {
	const resolved = resolveServerEventsOptions(options);
	if (Result.isFailure(resolved)) {
		Effect.runSync(
			Effect.logWarning(`analytics server events disabled: ${resolved.failure}`).pipe(
				Effect.provide(logger),
			),
		);
		return { send: () => Promise.resolve() };
	}

	const settings = resolved.success;
	const runtime = ManagedRuntime.make(Layer.mergeAll(ServerEvents.layer(settings), logger));
	return { send: promiseSender(runtime) };
}
