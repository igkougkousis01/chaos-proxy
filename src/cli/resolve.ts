import { resolveConfigPath } from '../config/discover.js';
import { loadConfigFile } from '../config/load.js';
import { baseChaos, createChaosResolver, effectiveRules } from '../config/rules.js';
import type { EffectiveRule } from '../config/rules.js';
import { presetChaos } from '../presets/index.js';
import type { PresetName } from '../presets/index.js';
import { assertValidTarget, resolveChaosOptions } from '../proxy/server.js';
import type { ChaosOptions, ProxyServerOptions, ResolvedChaosOptions } from '../proxy/server.js';
import { createSeededRandom } from '../random/seeded.js';
import { CliError, DEFAULT_PORT, inFlagTerms } from './options.js';
import type { CliCommand } from './options.js';

/** One endpoint rule as it ends up applying, with every default filled in. */
export interface EffectiveRuleView {
  /** The pattern this rule matches. */
  readonly match: string;
  /** The complete chaos a request this rule matches receives. */
  readonly chaos: ResolvedChaosOptions;
}

/**
 * Everything this run settled on, normalised and complete.
 *
 * This is the answer to "what will Chaos Proxy actually run with": every value
 * filled in, every layer already applied, and nothing left to interpret. It is
 * what `--print-config` prints, and it is derived from the very same merged
 * chaos the running proxy is handed — see {@link describeEffectiveChaos} — so
 * printing it can never describe a run other than the one that would happen.
 *
 * It holds configuration only. The seed is here because a user typed it and it
 * shapes the run; the generator built from it is not, because it is a function,
 * and neither is anything that only exists once traffic is flowing.
 */
export interface EffectiveConfig {
  /** The API being forwarded to. */
  readonly target: string;
  /** The port the proxy would listen on. */
  readonly port: number;
  /** Absolute path of the config file in use, or `undefined` if there is none. */
  readonly configPath: string | undefined;
  /** The preset applied, or `undefined` if none was asked for. */
  readonly preset: PresetName | undefined;
  /** The seed in use, exactly as typed, or `undefined` for ordinary randomness. */
  readonly seed: string | undefined;
  /** The complete chaos a request that no rule matches receives. */
  readonly defaults: ResolvedChaosOptions;
  /** Every endpoint rule, in order, with the chaos it actually applies. */
  readonly rules: readonly EffectiveRuleView[];
}

/** A command line and config file settled into something that can be run. */
export interface ResolvedCommand {
  /** TCP port to listen on. */
  readonly port: number;
  /** Options handed straight to `createProxyServer`. */
  readonly proxy: ProxyServerOptions;
  /** Absolute path of the config file in use, if there was one. */
  readonly configPath: string | undefined;
  /** How many endpoint rules that config file contributed. */
  readonly ruleCount: number;
  /**
   * The preset in use, if any, kept apart from `proxy` for the same reason the
   * seed is: by the time the options are settled a preset is indistinguishable
   * from the flags it stands for, and the startup summary still has to name it.
   */
  readonly preset: PresetName | undefined;
  /**
   * The seed in use, if any, kept apart from `proxy` because the generator it
   * produced cannot be printed and the string it came from is what the startup
   * summary has to name.
   */
  readonly seed: string | undefined;
  /**
   * The same command, described rather than executed.
   *
   * A view of `proxy` and the rules behind it, not a second opinion about them:
   * it is computed from the merged chaos this very command runs on, so
   * `--print-config` reports the run it would have started.
   */
  readonly effective: EffectiveConfig;
}

/**
 * The random source for this run: a generator seeded from `--seed`, or nothing
 * at all, which leaves the proxy core on `Math.random`.
 *
 * Seeding is deliberately a command-line concern only. It describes one run
 * rather than how an API should misbehave, so it has no place in a config file
 * that is checked in and shared.
 */
function randomFor(seed: string | undefined): Pick<ProxyServerOptions, 'random'> {
  return seed === undefined ? {} : { random: createSeededRandom(seed) };
}

/**
 * Runs `describe`, reporting a value the proxy core rejects as a usage mistake.
 *
 * Settling the configuration now means the core's validators run here rather
 * than when the server is created, so their complaints have to reach the user
 * the same way they always did: as one line naming the flag that carried the
 * value, not as a stack trace. Only command-line values can fail — a config
 * file's own values were checked against these same rules when it was read.
 *
 * @throws {CliError} If the core rejects a value.
 */
function reportingUsageErrors<T>(describe: () => T): T {
  try {
    return describe();
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new CliError(inFlagTerms(error.message));
    }

    throw error;
  }
}

/**
 * Fills in every default over the chaos this command already merged.
 *
 * This is the running proxy's own arithmetic, not a copy of it. `base` and each
 * rule arrive already layered — defaults, then rule, then preset, then flags —
 * so nothing here decides precedence; all it does is apply `resolveChaosOptions`
 * exactly where the proxy applies it. The static options become the proxy's
 * static chaos, and a rule's options over those are what its `resolveChaos`
 * hook produces for a request it matches. There is therefore one precedence
 * implementation, and the printed configuration is a rendering of it rather
 * than a second attempt at it.
 *
 * @throws {RangeError} If any value is outside its documented range.
 */
function describeEffectiveChaos(
  base: ChaosOptions,
  rules: readonly EffectiveRule[],
): Pick<EffectiveConfig, 'defaults' | 'rules'> {
  const defaults = resolveChaosOptions(base);

  return {
    defaults,
    rules: rules.map((rule) => ({
      match: rule.match,
      chaos: resolveChaosOptions(rule.chaos, defaults),
    })),
  };
}

/**
 * Combines what the user typed with what the config file says.
 *
 * Precedence runs one way throughout:
 *
 *     explicit chaos flags  >  --preset  >  config file  >  built-in defaults
 *
 * Chaos flags are applied last of all, so `--error-rate 0` switches error
 * injection off everywhere including inside endpoint rules — a flag typed on
 * the spot is always the final word. A preset sits directly beneath them and
 * above everything a file says, rules included: it names the scenario being
 * tested, and a rule that disagreed with it would make `--preset backend-down`
 * mean "the backend is down except where the file says otherwise". It applies
 * only the fields it defines, so `slow-api` sets the latency and leaves a
 * configured error rate exactly where it was.
 *
 * Which file that is comes from `resolveConfigPath`: an explicit `--config`,
 * otherwise `./chaos.yml` if it happens to be there, otherwise no file at all.
 *
 * The result is both runnable and printable, from one pass. `--print-config`
 * takes the description and stops; an ordinary run takes the options and
 * starts. Neither resolves anything the other does not.
 *
 * @throws {CliError} If neither the command line nor the config file names a
 * target, or if the proxy core rejects a value that was typed.
 * @throws {ConfigError} If the config file cannot be read or is not valid.
 */
export function resolveCommand(command: CliCommand): ResolvedCommand {
  const configPath = resolveConfigPath(command.configPath);
  const loaded = configPath === undefined ? undefined : loadConfigFile(configPath);
  const config = loaded?.config;

  const target = command.target ?? config?.target;

  if (target === undefined) {
    throw new CliError(
      loaded === undefined
        ? 'Missing required option --target, for example --target http://localhost:3000.'
        : `Missing target: ${loaded.path} does not set "target", so it must be given as --target http://localhost:3000.`,
    );
  }

  // The two layers that beat the config file, flattened once into the single
  // set of overrides the config layer already knows how to apply over its
  // defaults and over each rule. Nothing here re-implements that merging; it
  // only decides what gets handed to it.
  const overrides: ChaosOptions = { ...presetChaos(command.preset), ...command.chaos };
  const base = config === undefined ? overrides : baseChaos(config, overrides);
  const rules = config === undefined ? [] : effectiveRules(config, overrides);
  const port = command.port ?? config?.port ?? DEFAULT_PORT;

  // Checked before anything is described or started, so a configuration that
  // could not run is never printed as though it could.
  const effectiveChaos = reportingUsageErrors(() => {
    assertValidTarget(target);

    return describeEffectiveChaos(base, rules);
  });

  return {
    port,
    proxy: {
      target,
      ...base,
      // A config without rules leaves the proxy on its static options, so the
      // per-request path only exists when there is something to decide.
      ...(rules.length > 0 ? { resolveChaos: createChaosResolver(rules, base) } : {}),
      ...randomFor(command.seed),
    },
    configPath: loaded?.path,
    ruleCount: rules.length,
    preset: command.preset,
    seed: command.seed,
    effective: {
      target,
      port,
      configPath: loaded?.path,
      preset: command.preset,
      seed: command.seed,
      ...effectiveChaos,
    },
  };
}
