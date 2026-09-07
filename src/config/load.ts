import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { ConfigError, parseConfig } from './schema.js';
import type { ChaosConfig } from './schema.js';

/** A config file that was read, parsed and validated. */
export interface LoadedConfig {
  /** Absolute path the config was read from, for startup output and errors. */
  readonly path: string;
  /** The validated contents. */
  readonly config: ChaosConfig;
}

/** Turns a failed read into something the user can act on. */
function describeReadError(error: unknown, path: string): string {
  const code = (error as NodeJS.ErrnoException).code;

  switch (code) {
    case 'ENOENT':
      return `Config file not found: ${path}`;
    case 'EISDIR':
      return `Config path is a directory, not a file: ${path}`;
    case 'EACCES':
    case 'EPERM':
      return `Config file cannot be read: ${path}`;
    default:
      return `Could not read config file ${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * The first line of a YAML parse failure.
 *
 * The parser's own message continues with a snippet of the offending source,
 * which is more than a one-line CLI error should carry; the line and column it
 * opens with are the part the user needs.
 */
function firstLineOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return message.split('\n')[0] ?? message;
}

/**
 * Reads, parses and validates the config file at `configPath`.
 *
 * A relative path is resolved against the current working directory, so
 * `--config ./chaos.yml` means the file next to where the user is standing and
 * never one next to the installed executable.
 *
 * @throws {ConfigError} If the file cannot be read, is not valid YAML, or does
 * not match the config schema.
 */
export function loadConfigFile(configPath: string): LoadedConfig {
  const path = resolvePath(process.cwd(), configPath);
  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(describeReadError(error, path));
  }

  let document: unknown;

  try {
    document = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`Could not parse ${path} as YAML: ${firstLineOf(error)}`);
  }

  return { path, config: parseConfig(document) };
}
