/**
 * Built-in chaos presets: named starting points for the failure scenarios
 * people reach for most often.
 *
 * A preset is nothing but a small block of ordinary chaos options under a name,
 * so that trying the tool does not require remembering that "flaky" means
 * `--error-rate 0.25 --error-status 503`. Nothing downstream of the command
 * line knows presets exist: the CLI resolves one into the same effective chaos
 * options any other source produces, and the proxy core receives exactly what
 * it would have received had the flags been typed out.
 *
 * The registry is deliberately closed and internal. Custom presets, preset
 * files, composition, inheritance, and a `preset` field in the config file are
 * all out of scope — each of them turns a shortcut into a second configuration
 * language sitting next to the one that already exists.
 *
 * @internal Not part of the public API. It is a convenience of the command
 * line, not something a consumer of `createProxyServer` needs a name for.
 */

import type { ChaosOptions } from '../proxy/server.js';

/** Every preset name there is, in the order they are listed to the user. */
export const PRESET_NAMES = ['slow-api', 'flaky-api', 'timeout-heavy', 'backend-down'] as const;

/** The name of a built-in preset. */
export type PresetName = (typeof PRESET_NAMES)[number];

/** One built-in preset: the chaos it stands for, plus how to describe it. */
interface Preset {
  /**
   * One line for `--help`, phrased as what the preset does rather than as
   * which options it sets — the options are right here, and a user picking a
   * scenario is choosing a behaviour.
   */
  readonly summary: string;
  /** The chaos options the preset contributes, and only those. */
  readonly chaos: Readonly<ChaosOptions>;
}

/**
 * The presets themselves.
 *
 * Each one sets only the fields its scenario is actually about, so that
 * applying it leaves every unrelated setting — from a config file or from the
 * built-in defaults — exactly as it was. `slow-api` says nothing about errors,
 * and `flaky-api` says nothing about latency, on purpose.
 *
 * Frozen at both levels, so a run that layers flags over a preset can never
 * edit the preset every later reader would see. Nothing here is validated
 * separately either: these values go through the proxy core's own validator
 * like any others, and a test walks all of them through it so an invalid
 * preset cannot ship.
 */
export const PRESETS: Readonly<Record<PresetName, Preset>> = Object.freeze({
  'slow-api': Object.freeze({
    summary: 'A consistently slow backend: 1000ms latency',
    chaos: Object.freeze({ latencyMs: 1000 }),
  }),
  'flaky-api': Object.freeze({
    summary: 'An API that intermittently fails: 25% HTTP 503 failures',
    chaos: Object.freeze({ errorRate: 0.25, errorStatus: 503 }),
  }),
  'timeout-heavy': Object.freeze({
    summary: 'Frequent timeout conditions: 30% timeouts after 3000ms',
    chaos: Object.freeze({ timeoutRate: 0.3, timeoutMs: 3000 }),
  }),
  'backend-down': Object.freeze({
    summary: 'An unavailable backend: 100% HTTP 503 failures',
    chaos: Object.freeze({ errorRate: 1, errorStatus: 503 }),
  }),
});

/** Whether `value` names a built-in preset. */
export function isPresetName(value: string): value is PresetName {
  return (PRESET_NAMES as readonly string[]).includes(value);
}

/**
 * The chaos a preset contributes, as a fresh object.
 *
 * A copy rather than the frozen original, so a caller merging it with other
 * layers is working with values of its own and the registry stays untouched
 * however it is used. `undefined` — no `--preset` at all — contributes nothing.
 */
export function presetChaos(name: PresetName | undefined): ChaosOptions {
  return name === undefined ? {} : { ...PRESETS[name].chaos };
}

/** Width the preset names are padded to when they are listed together. */
const NAME_WIDTH = Math.max(...PRESET_NAMES.map((name) => name.length)) + 2;

/**
 * The presets as `--help` lists them, one per line and already indented.
 *
 * Rendered from the registry rather than written out beside it, so a preset
 * cannot be documented as something other than what it does.
 */
export const PRESET_HELP = PRESET_NAMES.map(
  (name) => `  ${name.padEnd(NAME_WIDTH)}${PRESETS[name].summary}`,
).join('\n');

/** The preset names as they are offered to someone who got one wrong. */
export const PRESET_LIST = PRESET_NAMES.join(', ');
