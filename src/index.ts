/**
 * Public entry point for the Chaos Proxy package.
 *
 * The proxy core can forward HTTP traffic to a target API, inject a fixed
 * artificial latency, answer a share of requests with a synthetic HTTP error,
 * and hold a share of requests open until they hit a synthetic timeout. It is
 * driven either from here or from the `chaos-proxy` command line, which is a
 * consumer of this API. Remaining chaos behaviour (connection failures) is
 * added in later features.
 */

export { createProxyServer } from './proxy/server.js';
export type { ProxyServerOptions } from './proxy/server.js';
