/**
 * Public entry point for the Chaos Proxy package.
 *
 * The proxy core can forward HTTP traffic to a target API, inject a fixed
 * artificial latency, answer a share of requests with a synthetic HTTP error,
 * hold a share of requests open until they hit a synthetic timeout, and destroy
 * the client connection of a share of requests outright. Chaos is the same for
 * every request unless a `resolveChaos` hook is supplied, which lets a caller
 * vary it per request without the core knowing anything about where those
 * decisions come from.
 *
 * It is driven either from here or from the `chaos-proxy` command line, which
 * is a consumer of this API and translates its YAML config — defaults plus
 * ordered endpoint rules — into exactly such a hook.
 *
 * That command line also has built-in `--preset` names for common failure
 * scenarios. They are deliberately not exported: a preset is a block of these
 * very options under a name, so by the time one reaches this API it is
 * indistinguishable from the options it stands for, and a caller here has the
 * options themselves to hand.
 *
 * The proxy prints nothing on its own. An optional `onRequestComplete` hook
 * reports what happened to each completed request, and the command line is what
 * turns those facts into the lines it prints. A request whose connection was
 * reset has no status code, so the event reports `null` rather than inventing
 * one.
 *
 * Chaos decisions use `Math.random` unless an optional `random` function is
 * supplied, which makes a run as reproducible as that function is. The command
 * line's `--seed` is one such function; the generator behind it is internal,
 * because a plain `() => number` is all the API asks for.
 */

export { createProxyServer } from './proxy/server.js';
export type {
  ChaosOptions,
  ProxyServerOptions,
  RequestLogEvent,
  RequestOutcome,
} from './proxy/server.js';
