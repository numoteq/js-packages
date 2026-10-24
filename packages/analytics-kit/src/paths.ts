/**
 * Browser-visible paths, derived from the site host so the page and the Worker agree without any
 * shared configuration. Dependency-free: `@numoteq/analytics-kit/client` ships this file alone.
 */

/**
 * The internal sGTM prefix, also the web container's `server_container_url`. The browser never
 * sends it as it is: the shim encodes every request under it into a token, and the Worker decodes
 * the token back into the sGTM path.
 */
export const SGTM_PREFIX = "/_sgtm";

/** Mixed into the hash. Changing it moves every site to new paths. */
const LABEL = "analytics/1";

/** FNV-1a, 32 bits. Only has to look random per site, not resist an attacker. */
function fnv1a(input: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < input.length; index += 1) {
		hash = Math.imul(hash ^ input.charCodeAt(index), 0x01000193);
	}
	return hash >>> 0;
}

function pathHash(host: string): string {
	return fnv1a(`${LABEL}\n${host.toLowerCase()}`).toString(36);
}

/** The `<script src>` that loads the container, e.g. `loaderPath(location.host)`. */
export function loaderPath(host: string): string {
	return `/${pathHash(host)}.js`;
}

/** `/<hash>/`: prefix of an encoded browser request. */
export function encodedPrefix(host: string): string {
	return `/${pathHash(host)}/`;
}

/**
 * The sGTM path of a decoded token: `/_sgtm/g/collect?v=2` becomes `/g/collect?v=2`. A path
 * outside the prefix, the bare prefix, or one whose remainder starts with `//` (a
 * protocol-relative URL that would leave sGTM) is `null`.
 */
export function sgtmPathOf(target: string): string | null {
	if (!target.startsWith(`${SGTM_PREFIX}/`) || target.startsWith(`${SGTM_PREFIX}//`)) return null;
	return target.slice(SGTM_PREFIX.length);
}
