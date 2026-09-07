import { parseArgs } from 'node:util';

import { PORT_MAX, PORT_MIN, isValidPort } from '../config/schema.js';
import { PRESET_HELP, PRESET_LIST, isPresetName } from '../presets/index.js';
import type { PresetName } from '../presets/index.js';
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
  /**
   * One line of guidance printed beneath the problem, or `undefined` when the
   * problem says everything there is to say.
   *
   * Kept apart from the message so that every user-facing error has the same
   * shape — a concise problem, then at most one action — without each thrower
   * having to decide how the two are punctuated together.
   */
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'CliError';
    this.hint = hint;
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
  /**
   * Built-in preset named by `--preset`, if any, kept as a name rather than as
   * the chaos it stands for: what it means is settled in `resolve.ts` alongside
   * every other source of chaos, and the name itself is what the startup
   * summary has to report.
   */
  readonly preset: PresetName | undefined;
  /**
   * Seed given to `--seed`, if any, kept as the opaque string it was typed as.
   * Absent means chaos decisions stay ordinarily random.
   */
  readonly seed: string | undefined;
  /** Whether `--quiet` was given, silencing everything but errors. */
  readonly quiet: boolean;
  /**
   * Whether `--print-config` was given, asking for the settled configuration
   * instead of a running proxy.
   *
   * Carried alongside a perfectly ordinary run rather than as a mode of its
   * own, because it needs everything a run needs: the same flags, the same
   * config file and the same precedence. Only the last step differs.
   */
  readonly printConfig: boolean;
}

/**
 * What the command line asked for: start the proxy, or print help or the
 * version and stop.
 */
export type ParsedCli =
  | { readonly kind: 'run'; readonly command: CliCommand }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' };

/**
 * Text printed by `--help`.
 *
 * A map of the command line rather than its documentation: what the tool is,
 * how it is invoked, every option once, the presets, and a few examples. The
 * prose that used to live here — the chaos ordering, what a log line looks
 * like, how the layers of configuration settle — is in the README, because help
 * someone has to read twice answers nothing the first time.
 *
 * Options are grouped into the ones that decide how the proxy runs and the ones
 * that decide how it misbehaves, which is the distinction a reader is actually
 * making while scanning. Plain text throughout: no colour, so it reads the same
 * in a pipe, a log and a terminal.
 */
export const HELP_TEXT = `${DISPLAY_NAME}

Inject latency, HTTP errors, timeouts and connection resets into local API
traffic, so you can test how an application copes with a misbehaving API.

Usage:
  ${CLI_NAME} --target <url> [options]
  ${CLI_NAME} --config <path> [options]
  ${CLI_NAME} [options]              # auto-loads ./chaos.yml when present

Core options:
  --target <url>            API to forward to (http: or https:)
  --port <1-65535>          Port to listen on, on ${LISTEN_HOST}. Default: ${DEFAULT_PORT}
  --config <path>           YAML config file with defaults and endpoint rules
  --preset <name>           Built-in chaos preset. See Presets below
  --seed <value>            Deterministic chaos decisions, reproducible runs
  --print-config            Print the resolved configuration and exit
  --quiet                   Suppress informational output; errors still print

Chaos options:
  --latency <ms>            Fixed delay added to every request
  --error-rate <0-1>        Fraction of requests answered with a synthetic error
  --error-status <400-599>  Status code used by injected errors. Default: 500
  --timeout-rate <0-1>      Fraction of requests held open and then timed out
  --timeout <ms>            How long a timed-out request is held. Default: 30000
  --reset-rate <0-1>        Probability of abruptly resetting the connection

Presets:
${PRESET_HELP}

  A preset is a starting point, so an explicit chaos flag still wins over it.

Other:
  -h, --help                Show this help
  -v, --version             Show the version

Examples:
  ${CLI_NAME} --target http://localhost:3000
  ${CLI_NAME} --target http://localhost:3000 --preset flaky-api
  ${CLI_NAME} --target http://localhost:3000 --error-rate 0.2 --seed test-run
  ${CLI_NAME} --print-config

--target is required unless a config file supplies it. A ./chaos.yml in the
current directory is loaded automatically; --config overrides it.`;

/**
 * Pointer added to a mistake in what was typed, so the user knows where to look.
 *
 * Only to those. A config file that will not load, a target the core rejects and
 * a port that is taken each come with guidance of their own, and appending this
 * to them as well would be a line that is always there and never the answer.
 */
export const USAGE_HINT = `Run \`${CLI_NAME} --help\` for usage.`;

/**
 * `parseArgs` complaints, in the CLI's own voice.
 *
 * Node words these for a JavaScript audience: single-quoted flags, no full
 * stops, and — for a value that starts with a dash — three lines of advice
 * about how to write it. Every other error this tool produces is one problem
 * sentence and at most one action, so these are rewritten to match rather than
 * left as the one place the CLI sounds like a library.
 *
 * Anything unrecognised keeps its first line, which is the problem itself; the
 * lines beneath it are the parser explaining itself and are dropped. A wording
 * Node changes therefore still reads as an ordinary error rather than breaking.
 */
export function describeParseError(message: string): CliError {
  const first = (message.split('\n')[0] ?? message).trim();

  const unknown = /^Unknown option '(-[^']*)'/.exec(first);

  if (unknown !== null) {
    return new CliError(`Unknown option ${unknown[1]}.`, USAGE_HINT);
  }

  const missing = /^Option '(--[^' ]+)[^']*' argument missing/.exec(first);

  if (missing !== null) {
    return new CliError(`Missing value for ${missing[1]}.`, USAGE_HINT);
  }

  // `--latency -1` reads as two flags, so the parser cannot tell a value from
  // the next option. The `=` form is the whole answer, and is worth more here
  // than a pointer to the help.
  const ambiguous = /^Option '(--[^']+)' argument is ambiguous/.exec(first);

  if (ambiguous !== null) {
    return new CliError(
      `Missing value for ${ambiguous[1]}.`,
      `A value starting with "-" must be written as ${ambiguous[1]}=<value>.`,
    );
  }

  const positional = /^Unexpected argument '([^']*)'/.exec(first);

  if (positional !== null) {
    return new CliError(
      `Unexpected argument ${JSON.stringify(positional[1])}.`,
      `${CLI_NAME} takes options only. ${USAGE_HINT}`,
    );
  }

  return new CliError(first.endsWith('.') ? first : `${first}.`, USAGE_HINT);
}

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
  resetRate: 'reset-rate',
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
 * A value the proxy core rejected, as a usage error the reader can scan.
 *
 * The core words its complaints as one sentence — `Invalid errorRate 5:
 * expected a number between 0 and 1 inclusive.` — which carries both the
 * problem and the expectation. Splitting them puts each user-facing error into
 * the same shape as every other: what is wrong, then what was wanted. The core
 * stays the single authority on the ranges themselves; this only decides where
 * the line breaks.
 *
 * A message worded some other way has no expectation to lift out and is used
 * whole, which reads longer but never wrong.
 */
export function usageErrorFrom(message: string): CliError {
  const inTerms = inFlagTerms(message);
  const at = inTerms.indexOf(': expected ');

  if (at === -1) {
    return new CliError(inTerms);
  }

  const expectation = inTerms.slice(at + ': expected '.length);

  return new CliError(
    `${inTerms.slice(0, at)}.`,
    `Expected ${expectation.charAt(0).toLowerCase()}${expectation.slice(1)}`,
  );
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
    throw new CliError(`Invalid --${flag} ${JSON.stringify(raw)}.`, 'Expected a number.');
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
  const value = raw.trim() === '' ? Number.NaN : Number(raw);

  // Text that is not a number and a number outside the range are the same
  // mistake to the reader — the port they typed is not one — so both are told
  // what a port is, rather than one of them being told only that it is not a
  // number.
  if (!isValidPort(value)) {
    throw new CliError(
      `Invalid --port ${JSON.stringify(raw)}.`,
      `Expected an integer between ${PORT_MIN} and ${PORT_MAX}.`,
    );
  }

  return value;
}

/**
 * Reads `--preset`.
 *
 * An unrecognised name is a mistake worth naming the alternatives for: presets
 * exist so that nothing has to be memorised, so a wrong guess should not send
 * anyone to `--help` to find out what the right ones were.
 *
 * @throws {CliError} If the value is empty or is not a built-in preset.
 */
function toPreset(raw: string): PresetName {
  if (!isPresetName(raw)) {
    throw new CliError(
      `Unknown preset ${JSON.stringify(raw)}.`,
      `Available presets: ${PRESET_LIST}.`,
    );
  }

  return raw;
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
        preset: { type: 'string' },
        port: { type: 'string' },
        latency: { type: 'string' },
        'error-rate': { type: 'string' },
        'error-status': { type: 'string' },
        'timeout-rate': { type: 'string' },
        timeout: { type: 'string' },
        'reset-rate': { type: 'string' },
        seed: { type: 'string' },
        quiet: { type: 'boolean' },
        'print-config': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }));
  } catch (error) {
    throw describeParseError(error instanceof Error ? error.message : String(error));
  }

  if (values.help === true) {
    return { kind: 'help' };
  }

  if (values.version === true) {
    return { kind: 'version' };
  }

  const configPath = values.config;

  if (configPath !== undefined && (typeof configPath !== 'string' || configPath === '')) {
    throw new CliError('Invalid --config "".', 'Expected a path, for example chaos.yml.');
  }

  const target = values.target;

  if (target !== undefined && (typeof target !== 'string' || target === '')) {
    throw new CliError(
      'Invalid --target "".',
      'Expected a URL, for example http://localhost:3000.',
    );
  }

  // A missing target is not decided here. Without `--config` there may still be
  // a `./chaos.yml` to pick up, and only the resolver knows whether there is,
  // so the complaint waits until config discovery has had its say.

  const seed = values.seed;

  // An empty seed is rejected rather than treated as "no seed": `--seed ""` is
  // a value the user meant to supply and got wrong, and silently falling back
  // to ordinary randomness would look exactly like a run that is reproducible.
  // Anything else is taken verbatim — no trimming, no case folding — so the
  // string in a script is the string the sequence comes from.
  if (seed !== undefined && (typeof seed !== 'string' || seed === '')) {
    throw new CliError(
      'Invalid --seed "".',
      'Expected a non-empty value, for example checkout-test.',
    );
  }

  const preset = values.preset;

  if (preset !== undefined && typeof preset !== 'string') {
    throw new CliError('Invalid --preset.', `Expected one of ${PRESET_LIST}.`);
  }

  const latencyMs = optionalNumber(values.latency, 'latency');
  const errorRate = optionalNumber(values['error-rate'], 'error-rate');
  const errorStatus = optionalNumber(values['error-status'], 'error-status');
  const timeoutRate = optionalNumber(values['timeout-rate'], 'timeout-rate');
  const timeoutMs = optionalNumber(values.timeout, 'timeout');
  const resetRate = optionalNumber(values['reset-rate'], 'reset-rate');

  // Flags that were not given are left off entirely rather than passed as
  // `undefined`, so a config value or the proxy core's own default can apply.
  const chaos: ChaosOptions = {
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(errorRate !== undefined ? { errorRate } : {}),
    ...(errorStatus !== undefined ? { errorStatus } : {}),
    ...(timeoutRate !== undefined ? { timeoutRate } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(resetRate !== undefined ? { resetRate } : {}),
  };

  return {
    kind: 'run',
    command: {
      configPath,
      port: typeof values.port === 'string' ? toPort(values.port) : undefined,
      target,
      chaos,
      preset: preset === undefined ? undefined : toPreset(preset),
      seed,
      quiet: values.quiet === true,
      printConfig: values['print-config'] === true,
    },
  };
}
