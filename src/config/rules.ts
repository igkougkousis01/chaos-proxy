import type { IncomingMessage } from 'node:http';

import { requestPathname } from '../proxy/server.js';
import type { ChaosOptions } from '../proxy/server.js';
import type { ChaosConfig } from './schema.js';

/**
 * Suffix that turns a pattern into a prefix match. It is the only wildcard
 * form there is: `*` anywhere else, `**`, and regular expressions are all
 * rejected, so what a pattern matches can be read off it at a glance.
 */
const WILDCARD_SUFFIX = '/*';

/** One rule with its chaos already merged, ready to hand to the proxy. */
export interface EffectiveRule {
  /** The pattern this rule matches, kept for diagnostics and tests. */
  readonly match: string;
  /** Chaos applied to a request this rule matches. */
  readonly chaos: ChaosOptions;
}

/**
 * Explains why `pattern` is not a usable match pattern, or `undefined` if it is.
 *
 * Returning the problem rather than throwing keeps this module free of any
 * dependency on how config errors are reported.
 */
export function describeMatchPattern(pattern: string): string | undefined {
  if (!pattern.startsWith('/')) {
    return 'must start with "/"';
  }

  if (pattern.includes('?') || pattern.includes('#')) {
    return 'must be a path only, without a query string or fragment';
  }

  const firstStar = pattern.indexOf('*');

  if (firstStar === -1) {
    return undefined;
  }

  if (firstStar !== pattern.length - 1 || !pattern.endsWith(WILDCARD_SUFFIX)) {
    return 'may only use "*" as a trailing "/*" wildcard, as in "/api/payments/*"';
  }

  return undefined;
}

/**
 * Whether `pathname` is matched by `pattern`.
 *
 * A pattern ending in `/*` matches that prefix and anything below it; any other
 * pattern must match the path exactly, so `/api/search` does not match
 * `/api/search/advanced` or `/api/searching`. `pathname` never carries a query
 * string, so `/api/search?q=test` is matched on `/api/search` alone.
 */
export function matchesPattern(pattern: string, pathname: string): boolean {
  if (pattern.endsWith(WILDCARD_SUFFIX)) {
    return pathname.startsWith(pattern.slice(0, -1));
  }

  return pathname === pattern;
}

/**
 * Layers chaos settings, with later ones overriding earlier ones field by field.
 *
 * Only fields that are actually present override, so a rule that sets nothing
 * but `errorRate` leaves the configured latency exactly as it was rather than
 * resetting it.
 */
function mergeChaos(...layers: readonly ChaosOptions[]): ChaosOptions {
  return Object.assign({}, ...layers) as ChaosOptions;
}

/**
 * The chaos applied to a request that no rule matches: the file's `defaults`
 * with any command-line chaos layered on top.
 */
export function baseChaos(config: ChaosConfig, overrides: ChaosOptions): ChaosOptions {
  return mergeChaos(config.defaults, overrides);
}

/**
 * The chaos each rule ends up applying, in the order the rules were written.
 *
 * Each entry is the file's `defaults`, then the rule's own fields, then any
 * command-line chaos — so a flag the user typed wins even over a rule, and a
 * rule wins over the defaults.
 */
export function effectiveRules(
  config: ChaosConfig,
  overrides: ChaosOptions,
): readonly EffectiveRule[] {
  return config.rules.map((rule) => ({
    match: rule.match,
    chaos: mergeChaos(config.defaults, rule.chaos, overrides),
  }));
}

/**
 * Builds the per-request hook the proxy calls to find out what to do.
 *
 * The first rule whose pattern matches wins outright; rules are never combined
 * and never scored against each other, so the behaviour of a file can be read
 * top to bottom. A request that matches nothing gets `base`.
 */
export function createChaosResolver(
  rules: readonly EffectiveRule[],
  base: ChaosOptions,
): (request: IncomingMessage) => ChaosOptions {
  return (request) => {
    const pathname = requestPathname(request.url ?? '/');

    for (const rule of rules) {
      if (matchesPattern(rule.match, pathname)) {
        return rule.chaos;
      }
    }

    return base;
  };
}
