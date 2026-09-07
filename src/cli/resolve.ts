import { loadConfigFile } from '../config/load.js';
import { baseChaos, createChaosResolver, effectiveRules } from '../config/rules.js';
import { presetChaos } from '../presets/index.js';
import type { PresetName } from '../presets/index.js';
import type { ChaosOptions, ProxyServerOptions } from '../proxy/server.js';
import { createSeededRandom } from '../random/seeded.js';
import { CliError, DEFAULT_PORT } from './options.js';
import type { CliCommand } from './options.js';

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
 * @throws {CliError} If neither the command line nor the config file names a
 * target.
 * @throws {ConfigError} If the config file cannot be read or is not valid.
 */
export function resolveCommand(command: CliCommand): ResolvedCommand {
  const loaded = command.configPath === undefined ? undefined : loadConfigFile(command.configPath);
  const config = loaded?.config;

  const target = command.target ?? config?.target;

  if (target === undefined) {
    throw new CliError(
      loaded === undefined
        ? 'Missing required option --target, for example --target http://localhost:3000.'
        : `Missing target: ${loaded.path} does not set "target", so it must be given as --target http://localhost:3000.`,
    );
  }

  const random = randomFor(command.seed);

  // The two layers that beat the config file, flattened once into the single
  // set of overrides the config layer already knows how to apply over its
  // defaults and over each rule. Nothing here re-implements that merging; it
  // only decides what gets handed to it.
  const overrides: ChaosOptions = { ...presetChaos(command.preset), ...command.chaos };

  if (config === undefined) {
    return {
      port: command.port ?? DEFAULT_PORT,
      proxy: { target, ...overrides, ...random },
      configPath: undefined,
      ruleCount: 0,
      preset: command.preset,
      seed: command.seed,
    };
  }

  const base = baseChaos(config, overrides);
  const rules = effectiveRules(config, overrides);

  return {
    port: command.port ?? config.port ?? DEFAULT_PORT,
    proxy: {
      target,
      ...base,
      // A config without rules leaves the proxy on its static options, so the
      // per-request path only exists when there is something to decide.
      ...(rules.length > 0 ? { resolveChaos: createChaosResolver(rules, base) } : {}),
      ...random,
    },
    configPath: loaded?.path,
    ruleCount: rules.length,
    preset: command.preset,
    seed: command.seed,
  };
}
