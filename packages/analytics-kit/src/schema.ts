import { Result, Schema } from "effect";

import type { UpstreamBinding } from "./upstream.js";

/** A Workers VPC or service binding, recognised by having a `fetch`. */
export const Binding = Schema.declare(
	(input: unknown): input is UpstreamBinding =>
		typeof input === "object" &&
		input !== null &&
		typeof (input as { fetch?: unknown }).fetch === "function",
	{ expected: "a Workers binding with fetch()" },
);

export const BaseUrl = Schema.String.check(
	Schema.makeFilter(
		(value) =>
			URL.canParse(value) &&
			/^https?:$/.test(new URL(value).protocol) &&
			new URL(value).pathname === "/",
		{ expected: "an http(s) origin without a path, such as https://sgtm.example.com" },
	),
);

/** A binding or an origin such as `https://sgtm.example.com`; a path would be dropped, so it fails. */
export const Upstream = Schema.Union([Binding, BaseUrl]);

/** The web container id (`GTM-…`) whose `gtm.js` is loaded, not the server container. */
export const GtmId = Schema.String.check(
	Schema.isPattern(/^GTM-[A-Z0-9]+$/, { expected: "a GTM-… id" }),
);

/**
 * Validates one optional part. A missing or invalid input is a failure describing what is off, so
 * a broken part turns only itself off and the caller can say why in one line.
 */
export function decodePart<S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	input: unknown,
	label: string,
	consequence: string,
): Result.Result<S["Type"], string> {
	if (input === undefined) return Result.fail(`${label} is missing, so ${consequence}`);
	const result = Schema.decodeUnknownResult(schema)(input);
	if (Result.isFailure(result)) {
		return Result.fail(`${label} is invalid, so ${consequence}: ${result.failure.message}`);
	}
	return Result.succeed(result.success);
}

/**
 * Like {@link decodePart}, but absent is a success: for options that have a default, such as the
 * Data Client path.
 */
export function optionalPart<S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	input: unknown,
	label: string,
	consequence: string,
): Result.Result<S["Type"] | undefined, string> {
	if (input === undefined) return Result.succeed(undefined);
	const result = Schema.decodeUnknownResult(schema)(input);
	if (Result.isFailure(result)) {
		return Result.fail(`${label} is invalid, so ${consequence}: ${result.failure.message}`);
	}
	return Result.succeed(result.success);
}
