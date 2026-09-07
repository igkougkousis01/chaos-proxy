/**
 * Public entry point for the Chaos Proxy package.
 *
 * The proxy core can forward HTTP traffic to a target API, inject a fixed
 * artificial latency, answer a share of requests with a synthetic HTTP error,
 * and hold a share of requests open until they hit a synthetic timeout.
 * Remaining chaos behaviour (connection failures) and CLI configuration are
 * added in later features.
 */

export { createProxyServer } from './proxy/server.js';
export type { ProxyServerOptions } from './proxy/server.js';

/** Human-readable name printed by the CLI. */
export const CLI_NAME = 'Chaos Proxy';

/**
 * Runs the CLI.
 *
 * For now this only identifies the tool; command parsing and chaos behaviour
 * are added in later features.
 */
export function run(): void {
  console.log(CLI_NAME);
}
