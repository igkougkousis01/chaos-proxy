import { parseArgs } from 'node:util';

import { PORT_MAX, PORT_MIN, isValidPort } from '../config/schema.js';
import type { ChaosOptions } from '../proxy/server.js';

/** Port the proxy listens on when neither `--port` nor a config supplies one. */
export const DEFAULT_PORT = 4000;

/**
 * Address the proxy binds to.
 *
 * Loopback only, and deliberately not configurable: a proxy whose whole purpose
 * is to break traffic should never become reachable from the rest of the
 * network by accident.
 */
export const LISTEN_HOST = '127.0.0.1';

/** Name the CLI is invoked as, used in usage and error output. */
export const CLI_NAME = 'chaos-proxy';

/** Human-readable name printed when the server starts. */
export const DISPLAY_NAME = 'Chaos Proxy';

/**
 * A problem with what the user typed: an unknown flag, a missing required
 * option, or a value that could not be read as a number.
 *
 * These are expected outcomes rather than defects, so the CLI prints the
 * message on its own and exits non-zero instead of letting a stack trace out.
 */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * A successfully parsed command line asking for the proxy to start.
 *
 * Everything the user did not type is left `undefined` rather than defaulted
 * here: a config file may still supply it, and only once that has been read can
 * anything be settled. Turning this into a runnable command is `resolve.ts`'s
 * job.
 */
export interface CliCommand {
  /** Path given to `--config`, if any. */
  readonly configPath: string | undefined;
  /** Port given to `--port`, if any. */
  readonly port: number | undefined;
  /** Target given to `--target`, if any. */
  readonly target: string | undefined;
  /** Chaos flags the user actually typed, and only those. */
  readonly chaos: ChaosOptions;
}

/**
 * What the command line asked for: start the proxy, or print help or the
 * version and stop.
 */
export type ParsedCli =
  | { readonly kind: 'run'; readonly command: CliCommand }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' };

/** Text printed by `--help`. */
export const HELP_TEXT = `${DISPLAY_NAME} — a local proxy that deliberately degrades traffic to an API,
so you can test how an application handles latency, errors and timeouts.

Usage:
  ${CLI_NAME} --target <url> [options]
  ${CLI_NAME} --config <path> [options]

Options:
  --target <url>            API to forward to (http: or https:). Required
                            unless the config file supplies it.
  --config <path>           YAML config file with defaults and endpoint rules.
  --port <1-65535>          Port to listen on. Default: ${DEFAULT_PORT}.
  --latency <ms>            Fixed delay added to every request.
  --error-rate <0-1>        Fraction of requests answered with a synthetic error.
  --error-status <400-599>  Status code used by injected errors. Default: 500.
  --timeout-rate <0-1>      Fraction of requests held open and then timed out.
  --timeout <ms>            How long a timed-out request is held. Default: 30000.
  -h, --help                Show this help.
  -v, --version             Show the version.

The proxy listens on ${LISTEN_HOST} only, so it is never exposed to the network.
Each request receives at most one injected outcome, decided in this order:
latency delay, then timeout, then error, then forwarding upstream.

A config file adds per-endpoint rules; the first rule whose "match" fits the
request path wins. Flags beat config values, which beat the built-in defaults.

Examples:
  ${CLI_NAME} --target http://localhost:3000

  ${CLI_NAME} \\
    --target http://localhost:3000 \\
    --latency 500 \\
    --error-rate 0.2

  ${CLI_NAME} --config chaos.yml`;

/** Pointer appended to usage errors, so the user knows where to look. */
export const USAGE_HINT = `Run \`${CLI_NAME} --help\` for usage.`;

/**
 * `createProxyServer` option names, mapped to the flag that carries each one.
 * Only used to report a validation error from the core in terms of the flag the
 * user actually typed.
 */
const FLAG_FOR_PROXY_OPTION: Readonly<Record<string, string>> = {
  latencyMs: 'latency',
  errorRate: 'error-rate',
  errorStatus: 'error-status',
  timeoutRate: 'timeout-rate',
  timeoutMs: 'timeout',
};

/**
 * Rewrites a `createProxyServer` validation message in terms of the flag that
 * carried the value, so `--error-rate 5` is not reported as `errorRate`.
 *
 * Only the leading `Invalid <option>` is rewritten, so a value quoted later in
 * the message can never be edited by accident. A message the core words
 * differently passes through unchanged, which reads worse but never wrong.
 */
export function inFlagTerms(message: string): string {
  for (const [option, flag] of Object.entries(FLAG_FOR_PROXY_OPTION)) {
    const prefix = `Invalid ${option} `;

    if (message.startsWith(prefix)) {
      return `Invalid --${flag} ${message.slice(prefix.length)}`;
    }
  }

  return message;
}

/**
 * Reads a flag value as a number.
 *
 * This is the only numeric checking the CLI does for chaos options: it turns
 * text into a number and rejects text that is not one. Whether that number is a
 * usable rate, duration or status is decided by `createProxyServer`, which
 * stays the single source of truth for those ranges.
 *
 * @throws {CliError} If the value is empty or not numeric.
 */
function toNumber(flag: string, raw: string): number {
  const value = raw.trim() === '' ? Number.NaN : Number(raw);

  if (Number.isNaN(value)) {
    throw new CliError(`Invalid --${flag} ${JSON.stringify(raw)}: expected a number.`);
  }

  return value;
}

/**
 * Reads `--port`.
 *
 * Unlike the chaos options there is no proxy-core validator to defer to, so the
 * range lives in the config schema instead, shared with the config file's own
 * `port`. Out-of-range ports are rejected rather than clamped, so a typo cannot
 * quietly move the listener somewhere else.
 *
 * @throws {CliError} If the value is not an integer from 1 to 65535.
 */
function toPort(raw: string): number {
  const value = toNumber('port', raw);

  if (!isValidPort(value)) {
    throw new CliError(
      `Invalid --port ${JSON.stringify(raw)}: expected an integer between ${PORT_MIN} and ${PORT_MAX}.`,
    );
  }

  return value;
}

/** Reads an optional numeric flag, leaving it absent when it was not given. */
function optionalNumber(raw: string | boolean | undefined, flag: string): number | undefined {
  return typeof raw === 'string' ? toNumber(flag, raw) : undefined;
}

/**
 * Parses the command line into an instruction for the CLI to carry out.
 *
 * `--help` and `--version` win over everything else, including a missing
 * `--target`, so they always work.
 *
 * @throws {CliError} If an option is unknown, missing its value, missing
 * entirely while required, or not readable as a number.
 */
export function parseCliArgs(argv: readonly string[]): ParsedCli {
  let values: Record<string, string | boolean | undefined>;

  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        target: { type: 'string' },
        config: { type: 'string' },
        port: { type: 'string' },
        latency: { type: 'string' },
        'error-rate': { type: 'string' },
        'error-status': { type: 'string' },
        'timeout-rate': { type: 'string' },
        timeout: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }));
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  if (values.help === true) {
    return { kind: 'help' };
  }

  if (values.version === true) {
    return { kind: 'version' };
  }

  const configPath = values.config;

  if (configPath !== undefined && (typeof configPath !== 'string' || configPath === '')) {
    throw new CliError('Invalid --config: expected a path, for example --config chaos.yml.');
  }

  const target = values.target;

  if (target !== undefined && (typeof target !== 'string' || target === '')) {
    throw new CliError(
      'Invalid --target: expected a URL, for example --target http://localhost:3000.',
    );
  }

  // Without a config file there is nowhere else a target could come from, so
  // the mistake is worth reporting straight away. With one, the check waits
  // until the file has been read.
  if (target === undefined && configPath === undefined) {
    throw new CliError(
      'Missing required option --target, for example --target http://localhost:3000.',
    );
  }

  const latencyMs = optionalNumber(values.latency, 'latency');
  const errorRate = optionalNumber(values['error-rate'], 'error-rate');
  const errorStatus = optionalNumber(values['error-status'], 'error-status');
  const timeoutRate = optionalNumber(values['timeout-rate'], 'timeout-rate');
  const timeoutMs = optionalNumber(values.timeout, 'timeout');

  // Flags that were not given are left off entirely rather than passed as
  // `undefined`, so a config value or the proxy core's own default can apply.
  const chaos: ChaosOptions = {
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(errorRate !== undefined ? { errorRate } : {}),
    ...(errorStatus !== undefined ? { errorStatus } : {}),
    ...(timeoutRate !== undefined ? { timeoutRate } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };

  return {
    kind: 'run',
    command: {
      configPath,
      port: typeof values.port === 'string' ? toPort(values.port) : undefined,
      target,
      chaos,
    },
  };
}
