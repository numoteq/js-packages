/**
 * Server-originated events: an API route or an action sends through the Measurement Protocol
 * client of our sGTM, which routes them to GA4, Meta CAPI, Umami and OpenPanel like any other hit.
 */

export { RequestContext, clientIdOf, fromRequest } from "./context.js";
export type { Consent, ConsentCategory } from "./context.js";
export {
	ServerEvents,
	ServerEventRejected,
	ServerEventUnavailable,
	createServerEvents,
	gcsOf,
	resolveServerEventsOptions,
} from "./send.js";
export type {
	ServerEvent,
	ServerEventsClient,
	ServerEventsOptions,
	ServerEventsSettings,
} from "./send.js";
