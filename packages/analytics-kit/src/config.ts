import { Context, Layer, Result } from "effect";

import { decodePart, GtmId, Upstream } from "./schema.js";
import { toTarget, type UpstreamInput, type UpstreamTarget } from "./upstream.js";

export type { UpstreamBinding, UpstreamInput } from "./upstream.js";

/**
 * What a site passes in, usually straight from its Worker env. Every part is optional and turns
 * only itself off when missing, so previews and local development stay quiet.
 */
export interface AnalyticsOptions {
	/** Id of the web container (`GTM-…`) whose `gtm.js` is loaded, not of the server container. */
	readonly gtmId?: string | undefined;
	/** Server-side GTM: a Workers VPC or service binding, or a base URL. */
	readonly sgtm?: UpstreamInput | undefined;
}

export interface ResolvedOptions {
	readonly gtmId: string | undefined;
	readonly sgtm: UpstreamTarget | undefined;
	/** Why a part is off, in plain language; logged once when the proxy is created. */
	readonly warnings: readonly string[];
}

export class ProxyConfig extends Context.Service<ProxyConfig, ResolvedOptions>()(
	"@numoteq/analytics-kit-kit/proxy-config",
) {
	static layer(options: ResolvedOptions): Layer.Layer<ProxyConfig> {
		return Layer.succeed(ProxyConfig, options);
	}
}

/**
 * Validates each part on its own: a missing or invalid `gtmId` empties the loader alone, while
 * without `sgtm` both the loader and the prefix are off.
 */
export function resolveOptions(options: AnalyticsOptions): ResolvedOptions {
	const gtmId = decodePart(GtmId, options.gtmId, "gtmId", "the loader serves an empty script");
	const sgtm = decodePart(
		Upstream,
		options.sgtm,
		"sgtm",
		"the loader serves an empty script and /_sgtm answers 404",
	);

	return {
		gtmId: Result.isSuccess(gtmId) ? gtmId.success : undefined,
		sgtm: Result.isSuccess(sgtm) ? toTarget(sgtm.success) : undefined,
		warnings: [gtmId, sgtm].flatMap((part) => (Result.isFailure(part) ? [part.failure] : [])),
	};
}
