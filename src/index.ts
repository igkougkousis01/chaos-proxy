/**
 * Public entry point for the Chaos Proxy package.
 *
 * The proxy core can forward HTTP traffic to a target API, inject a fixed
 * artificial latency, answer a share of requests with a synthetic HTTP error,
 * and hold a share of requests open until they hit a synthetic timeout. Chaos
 * is the same for every request unless a `resolveChaos` hook is supplied, which
 * lets a caller vary it per request without the core knowing anything about
 * where those decisions come from.
 *
 * It is driven either from here or from the `chaos-proxy` command line, which
 * is a consumer of this API and translates its YAML config — defaults plus
 * ordered endpoint rules — into exactly such a hook. Remaining chaos behaviour
 * (connection failures) is added in later features.
 */

export { createProxyServer } from './proxy/server.js';
export type { ChaosOptions, ProxyServerOptions } from './proxy/server.js';
