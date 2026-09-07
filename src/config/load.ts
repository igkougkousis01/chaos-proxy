import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { ConfigError, configErrorIn, parseConfig } from './schema.js';
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
 * opens with are the part the user needs. That first line ends in a colon
 * introducing the snippet, so the colon goes with it and a full stop takes its
 * place — nothing else about the parser's wording is rewritten.
 */
function firstLineOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const first = message.split('\n')[0] ?? message;

  return first.endsWith(':') ? `${first.slice(0, -1)}.` : first;
}

/**
 * Reads, parses and validates the config file at `configPath`.
 *
 * A relative path is resolved against the current working directory, so
 * `--config ./chaos.yml` means the file next to where the user is standing and
 * never one next to the installed executable.
 *
 * Every message this can produce names that resolved path, schema complaints
 * included: the file in effect may have been discovered rather than typed, so
 * "which file is this about" is never left to be inferred.
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

  try {
    return { path, config: parseConfig(document) };
  } catch (error) {
    // The schema validates a parsed document and knows nothing about files, so
    // the file is named here instead of being threaded through every check.
    throw error instanceof ConfigError ? configErrorIn(error, path) : error;
  }
}
