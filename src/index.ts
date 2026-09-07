/**
 * Public entry point for the Chaos Proxy package.
 *
 * The proxy core can forward HTTP traffic to a target API. Chaos behaviour
 * (latency, errors, timeouts) and CLI configuration are added in later
 * features.
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
