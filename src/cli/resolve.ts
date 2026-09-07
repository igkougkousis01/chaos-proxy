import { loadConfigFile } from '../config/load.js';
import { baseChaos, createChaosResolver, effectiveRules } from '../config/rules.js';
import type { ProxyServerOptions } from '../proxy/server.js';
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
 * Precedence runs one way throughout: a command-line flag beats a config value,
 * and a config value beats the built-in default. Chaos flags are applied last
 * of all, so `--error-rate 0` switches error injection off everywhere including
 * inside endpoint rules — a flag typed on the spot is always the final word.
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

  if (config === undefined) {
    return {
      port: command.port ?? DEFAULT_PORT,
      proxy: { target, ...command.chaos, ...random },
      configPath: undefined,
      ruleCount: 0,
      seed: command.seed,
    };
  }

  const base = baseChaos(config, command.chaos);
  const rules = effectiveRules(config, command.chaos);

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
    seed: command.seed,
  };
}
