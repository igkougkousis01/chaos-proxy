import { resolveChaosOptions } from '../proxy/server.js';
import type { ChaosOptions } from '../proxy/server.js';
import { describeMatchPattern } from './rules.js';

/**
 * A problem with the contents of a config file: a field that does not belong, a
 * value of the wrong shape, or a chaos value the proxy core will not accept.
 *
 * Like a usage mistake on the command line these are expected outcomes rather
 * than defects, so the CLI prints the message on its own and exits non-zero
 * instead of letting a stack trace out.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** One endpoint rule: a path pattern plus the chaos it applies. */
export interface ChaosRuleConfig {
  /** Exact path, or a trailing-wildcard prefix such as `/api/payments/*`. */
  readonly match: string;
  /** Chaos this rule contributes, kept apart from the pattern it matches on. */
  readonly chaos: ChaosOptions;
}

/**
 * A validated config file.
 *
 * `target` and `port` stay optional here because the command line may supply
 * either of them instead; deciding which one wins is the CLI's job, not the
 * schema's. `defaults` and `rules` are always present so consumers never have
 * to distinguish "absent" from "empty".
 */
export interface ChaosConfig {
  readonly target: string | undefined;
  readonly port: number | undefined;
  readonly defaults: ChaosOptions;
  readonly rules: readonly ChaosRuleConfig[];
}

/** Lowest port a listener may be asked to bind. */
export const PORT_MIN = 1;

/** Highest port a listener may be asked to bind. */
export const PORT_MAX = 65_535;

/**
 * Whether `value` is a port a listener can actually be bound to.
 *
 * Shared with the `--port` flag, so a port is accepted or rejected identically
 * wherever it is written.
 */
export function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= PORT_MIN && value <= PORT_MAX;
}

/** Top-level fields a config file may contain. Anything else is a mistake. */
const TOP_LEVEL_FIELDS = ['target', 'port', 'defaults', 'rules'] as const;

/** Chaos fields, which are spelled exactly as the proxy options they become. */
const CHAOS_FIELDS = [
  'latencyMs',
  'errorRate',
  'errorStatus',
  'timeoutRate',
  'timeoutMs',
  'resetRate',
] as const satisfies readonly (keyof ChaosOptions)[];

/** Fields one entry of `rules` may contain. */
const RULE_FIELDS = ['match', ...CHAOS_FIELDS] as const;

/** @throws {ConfigError} Always; the return type only helps control flow. */
function invalid(problem: string): never {
  throw new ConfigError(`Invalid config: ${problem}`);
}

/** Whether `value` is a YAML mapping rather than a list or a scalar. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rejects fields that are not part of the schema.
 *
 * Unknown fields are an error rather than something to ignore: a misspelled
 * `errorRate` that is silently dropped looks exactly like chaos that does not
 * work, which is a far worse way to find out.
 */
function assertKnownFields(
  mapping: Record<string, unknown>,
  known: readonly string[],
  where: string,
): void {
  for (const field of Object.keys(mapping)) {
    if (!known.includes(field)) {
      invalid(`unknown field ${JSON.stringify(field)}${where}.`);
    }
  }
}

/**
 * Hands a block of chaos values to the proxy core for range checking, and
 * re-words its complaint in terms of where in the file the value was written.
 *
 * The core stays the single authority on what a rate, duration or status may
 * be, so a config file can never accept a value the programmatic API rejects.
 * Option names and config field names are deliberately identical, so only the
 * path in front of the name has to be added.
 */
function assertChaosValues(chaos: ChaosOptions, path: string): void {
  try {
    resolveChaosOptions(chaos);
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }

    const prefix = 'Invalid ';

    if (error.message.startsWith(prefix)) {
      invalid(`${path}.${error.message.slice(prefix.length)}`);
    }

    invalid(`${path}: ${error.message}`);
  }
}

/**
 * Reads the chaos fields out of an already-checked mapping.
 *
 * Only their type is checked here; `NaN` and infinities are numbers as far as
 * YAML is concerned and are left for {@link assertChaosValues} to reject, so
 * their message comes from the same place as every other range complaint.
 */
function readChaosFields(mapping: Record<string, unknown>, path: string): ChaosOptions {
  const chaos: { -readonly [K in keyof ChaosOptions]?: number } = {};

  for (const field of CHAOS_FIELDS) {
    const value = mapping[field];

    if (value === undefined) {
      continue;
    }

    if (typeof value !== 'number') {
      invalid(`${path}.${field} must be a number.`);
    }

    chaos[field] = value;
  }

  assertChaosValues(chaos, path);

  return chaos;
}

/** Reads the optional `defaults` block. */
function readDefaults(value: unknown): ChaosOptions {
  if (value === undefined) {
    return {};
  }

  if (!isMapping(value)) {
    invalid('"defaults" must be a mapping of chaos settings.');
  }

  assertKnownFields(value, CHAOS_FIELDS, ' in "defaults"');

  return readChaosFields(value, 'defaults');
}

/** Reads the optional `rules` list, in the order it was written. */
function readRules(value: unknown): readonly ChaosRuleConfig[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    invalid('"rules" must be a list of rules.');
  }

  return (value as readonly unknown[]).map((entry, index) => {
    const path = `rules[${index}]`;

    if (!isMapping(entry)) {
      invalid(`${path} must be a mapping with a "match" field.`);
    }

    assertKnownFields(entry, RULE_FIELDS, ` in ${path}`);

    const match = entry.match;

    if (match === undefined) {
      invalid(`${path} is missing the required "match" field.`);
    }

    if (typeof match !== 'string') {
      invalid(`${path}.match must be a string.`);
    }

    const problem = describeMatchPattern(match);

    if (problem !== undefined) {
      invalid(`${path}.match ${JSON.stringify(match)} ${problem}.`);
    }

    return { match, chaos: readChaosFields(entry, path) };
  });
}

/** Reads the optional `target`, leaving URL checking to the proxy core. */
function readTarget(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    invalid('"target" must be a string.');
  }

  if (value === '') {
    invalid('"target" must not be empty.');
  }

  return value;
}

/** Reads the optional `port`, using the same range as `--port`. */
function readPort(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !isValidPort(value)) {
    invalid(`"port" must be an integer between ${PORT_MIN} and ${PORT_MAX}.`);
  }

  return value;
}

/**
 * Validates one parsed YAML document as a config file.
 *
 * Takes the already-parsed document rather than text, so that reading files and
 * understanding their contents stay separable — and testable — apart.
 *
 * @throws {ConfigError} If the document is not a mapping, contains a field that
 * is not part of the schema, or holds a value the schema or the proxy core
 * rejects.
 */
export function parseConfig(document: unknown): ChaosConfig {
  if (!isMapping(document)) {
    invalid('the file must contain a YAML mapping, for example "target: http://localhost:3000".');
  }

  assertKnownFields(document, TOP_LEVEL_FIELDS, '');

  return {
    target: readTarget(document.target),
    port: readPort(document.port),
    defaults: readDefaults(document.defaults),
    rules: readRules(document.rules),
  };
}
