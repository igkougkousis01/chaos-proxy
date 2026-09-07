import { statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

/**
 * The config file Chaos Proxy looks for when `--config` was not given.
 *
 * Exactly one name, in exactly one directory. There is no `.chaos.yml`, no
 * `chaos.yaml`, no walk up the parent directories and nothing in the home
 * directory: a developer who cannot tell which file is in effect is worse off
 * than one who has to type `--config`, and every extra candidate makes that
 * question harder to answer.
 */
export const CONVENTIONAL_CONFIG_FILE = 'chaos.yml';

/**
 * Whether `path` names a file that can be read as a config.
 *
 * A directory called `chaos.yml` is not one, and is passed over rather than
 * discovered and then reported as unreadable — discovery is a convenience, and
 * a convenience should not invent an error. An explicit `--config` pointing at
 * the same directory still fails, loudly, because there the user said what they
 * meant.
 */
function isReadableFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * The config file this run should read, if any.
 *
 * Resolution has exactly three steps, and stops at the first that applies:
 *
 *     an explicit --config path  >  ./chaos.yml if it exists  >  no config file
 *
 * An explicit path is returned whether or not anything is there, so a
 * `--config` naming a file that does not exist fails and says so instead of
 * quietly falling back to the conventional one. Explicit intent wins even when
 * it is wrong, because a silent fallback would run the wrong configuration and
 * look like success.
 *
 * The conventional file is only ever looked for in `cwd` itself, and its
 * absence is not an error: a run with no config file is the ordinary case.
 *
 * Returns an absolute path, so everything downstream — the startup summary,
 * `--print-config`, and every error message — names one unambiguous file.
 */
export function resolveConfigPath(
  configPath: string | undefined,
  cwd: string = process.cwd(),
): string | undefined {
  if (configPath !== undefined) {
    return resolvePath(cwd, configPath);
  }

  const conventional = resolvePath(cwd, CONVENTIONAL_CONFIG_FILE);

  return isReadableFile(conventional) ? conventional : undefined;
}
