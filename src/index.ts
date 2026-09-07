/**
 * Public entry point for the Chaos Proxy package.
 *
 * The proxy itself is not implemented yet — this module currently only exposes
 * the pieces the CLI needs so the package has a stable, testable surface.
 */

/** Human-readable name printed by the CLI. */
export const CLI_NAME = 'Chaos Proxy';

/**
 * Runs the CLI.
 *
 * For now this only identifies the tool; command parsing and proxy behaviour
 * are added in later features.
 */
export function run(): void {
  console.log(CLI_NAME);
}
