import { stringify } from 'yaml';

import type { ResolvedChaosOptions } from '../proxy/server.js';
import type { EffectiveConfig } from './resolve.js';

/**
 * One block of chaos as it is printed.
 *
 * Written out field by field rather than spread, so the order the keys appear
 * in is decided here and stays put however the resolver happens to build its
 * objects. It is the order the flags are documented in, which is also the order
 * the decisions are taken in.
 */
function chaosDocument(chaos: ResolvedChaosOptions): Record<string, number> {
  return {
    latencyMs: chaos.latencyMs,
    errorRate: chaos.errorRate,
    errorStatus: chaos.errorStatus,
    timeoutRate: chaos.timeoutRate,
    timeoutMs: chaos.timeoutMs,
    resetRate: chaos.resetRate,
  };
}

/**
 * The resolved configuration as YAML, ready to print.
 *
 * A view of the run rather than a copy of the file: comments, ordering and
 * formatting from the source are all gone, the layers are already applied, and
 * every value is filled in. Reading it back in as a config file is not the
 * point — answering "why is this request failing" without starting the proxy
 * is.
 *
 * Everything is printed every time, including zeroes and the values nothing
 * configured. A field that disappeared when it was switched off would make the
 * output a puzzle: `resetRate: 0` says resets are off, whereas a missing
 * `resetRate` could equally mean the tool forgot about it. `config`, `preset`
 * and `seed` are `null` rather than absent for the same reason.
 *
 * Rules are the effective rules — the file's own values with the preset and any
 * typed flag already layered over them — so a rule printed here is what a
 * request matching it actually receives, not what the file happened to say.
 *
 * Nothing beyond configuration appears: no environment, no headers, no request
 * or response data. The seed is here because it is a value the user chose.
 */
export function formatEffectiveConfig(effective: EffectiveConfig): string {
  const document = {
    target: effective.target,
    port: effective.port,
    config: effective.configPath ?? null,
    preset: effective.preset ?? null,
    seed: effective.seed ?? null,
    defaults: chaosDocument(effective.defaults),
    rules: effective.rules.map((rule) => ({
      match: rule.match,
      ...chaosDocument(rule.chaos),
    })),
  };

  // Line folding off: a long target or a deep path is easier to read, and to
  // grep, on one line than wrapped at some width the terminal never asked for.
  return stringify(document, { lineWidth: 0 }).trimEnd();
}
