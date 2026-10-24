import { SGTM_PREFIX } from "./paths.js";

/**
 * The shim prepended to `gtm.js`. It encodes every same-origin request under the sGTM prefix,
 * through the channels gtm.js and gtag.js send with: `fetch`, `sendBeacon` and the `src` of script
 * and image elements. The service worker iframe under the sGTM prefix is never loaded, in this
 * window or any same-origin frame, so gtag sends from the page without a failed request.
 *
 * The token encoding is a copy of `encodeToken` in `codec.ts`; the tests round-trip both.
 * `window` is the only free identifier, so tests can run the shim against a fake window.
 */
export function shimSource(encodedPrefix: string): string {
	return `"use strict";
	if (window.__analyticsShim) return;
	window.__analyticsShim = true;

	var PREFIX = ${JSON.stringify(`${SGTM_PREFIX}/`)};
	var ENCODED = ${JSON.stringify(encodedPrefix)};

	function ours(value) {
		try {
			// Script URLs arrive as TrustedScriptURL where Trusted Types exist; they stringify to the URL.
			var url = new window.URL(String(value), window.location.href);
			if (url.origin !== window.location.origin) return null;
			return url.pathname.indexOf(PREFIX) === 0 ? url : null;
		} catch (error) {
			return null;
		}
	}

	function rewrite(value) {
		var url = ours(value);
		if (!url) return value;
		var salt = String.fromCharCode.apply(null, window.crypto.getRandomValues(new Uint8Array(4)));
		var plain = url.pathname + url.search;
		var token = salt;
		for (var index = 0; index < plain.length; index += 1) {
			token += String.fromCharCode(plain.charCodeAt(index) ^ salt.charCodeAt(index % 4));
		}
		return url.origin + ENCODED + window.btoa(token).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
	}

	var nativeFetch = window.fetch;
	if (typeof nativeFetch === "function") {
		window.fetch = function (input, init) {
			var target = typeof input === "string" || input instanceof window.URL ? rewrite(input) : input;
			return nativeFetch.call(this, target, init);
		};
	}

	var navigator = window.navigator;
	if (navigator && typeof navigator.sendBeacon === "function") {
		var nativeSendBeacon = navigator.sendBeacon;
		navigator.sendBeacon = function (url, data) {
			return nativeSendBeacon.call(navigator, rewrite(url), data);
		};
	}

	function hookSrc(element, set) {
		var prototype = element && element.prototype;
		var descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, "src");
		if (!descriptor || !descriptor.get || !descriptor.set) return;
		Object.defineProperty(prototype, "src", {
			configurable: true,
			enumerable: descriptor.enumerable,
			get: descriptor.get,
			set: function (value) {
				set(descriptor.set, this, value);
			},
		});
	}

	function setEncoded(nativeSet, element, value) {
		try {
			nativeSet.call(element, rewrite(value));
		} catch (error) {
			// A Trusted Types policy rejects the plain string; fall back to the original value.
			nativeSet.call(element, value);
		}
	}

	function skipOurs(nativeSet, element, value) {
		if (!ours(value)) nativeSet.call(element, value);
	}

	// gtag creates the service worker iframe inside an empty same-origin iframe, whose own
	// HTMLIFrameElement this window's hook does not cover, so every frame it reaches is hooked too.
	function hookFrames(realm) {
		if (realm.__analyticsFrames) return;
		realm.__analyticsFrames = true;
		var prototype = realm.HTMLIFrameElement && realm.HTMLIFrameElement.prototype;
		if (!prototype) return;
		hookSrc(realm.HTMLIFrameElement, skipOurs);
		["contentWindow", "contentDocument"].forEach(function (name) {
			var descriptor = Object.getOwnPropertyDescriptor(prototype, name);
			if (!descriptor || !descriptor.get) return;
			Object.defineProperty(prototype, name, {
				configurable: true,
				enumerable: descriptor.enumerable,
				get: function () {
					var value = descriptor.get.call(this);
					try {
						var child = name === "contentWindow" ? value : value && value.defaultView;
						if (child) hookFrames(child);
					} catch (error) {
						// A cross-origin frame cannot be touched and never loads our iframe.
					}
					return value;
				},
			});
		});
	}

	hookSrc(window.HTMLScriptElement, setEncoded);
	hookSrc(window.HTMLImageElement, setEncoded);
	hookFrames(window);`;
}

/** The shim as served: an IIFE that guards itself with a window flag. */
export function renderShim(encodedPrefix: string): string {
	return `(function (window) {\n${shimSource(encodedPrefix)}\n})(window);\n`;
}
