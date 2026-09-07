import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfigFile } from '../../src/config/load.js';
import { ConfigError } from '../../src/config/schema.js';

/**
 * These tests cover getting a file off disk and through the YAML parser. What
 * the resulting document is allowed to contain is covered in `schema.test.ts`,
 * so only enough of the schema is exercised here to prove the two are joined up.
 */

const tempDirs: string[] = [];
let restoreCwd: string | undefined;

afterEach(() => {
  if (restoreCwd !== undefined) {
    process.chdir(restoreCwd);
    restoreCwd = undefined;
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** A scratch directory that is removed after the test that made it. */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-proxy-config-'));
  tempDirs.push(dir);

  return dir;
}

/** Writes `contents` to a config file and returns its absolute path. */
function writeConfig(contents: string, name = 'chaos.yml'): string {
  const path = join(makeTempDir(), name);
  writeFileSync(path, contents, 'utf8');

  return path;
}

describe('loadConfigFile', () => {
  it('reads, parses and validates a config file', () => {
    const path = writeConfig(`target: http://localhost:3000

defaults:
  latencyMs: 100

rules:
  - match: /api/payments/*
    errorRate: 0.3
    errorStatus: 503
`);

    expect(loadConfigFile(path)).toEqual({
      path,
      config: {
        target: 'http://localhost:3000',
        port: undefined,
        defaults: { latencyMs: 100 },
        rules: [{ match: '/api/payments/*', chaos: { errorRate: 0.3, errorStatus: 503 } }],
      },
    });
  });

  it('reports the absolute path it read', () => {
    const path = writeConfig('target: http://localhost:3000\n');

    expect(loadConfigFile(path).path).toBe(path);
  });

  it('resolves a relative path against the current working directory', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'chaos.yml'), 'target: http://localhost:3000\n', 'utf8');

    restoreCwd = process.cwd();
    process.chdir(dir);

    // Not against wherever the executable happens to live: the file next to
    // where the user is standing is the one they meant.
    expect(loadConfigFile('./chaos.yml').config.target).toBe('http://localhost:3000');
  });

  it('reports a missing file without a stack trace', () => {
    const path = join(makeTempDir(), 'absent.yml');

    expect(() => loadConfigFile(path)).toThrow(ConfigError);
    expect(() => loadConfigFile(path)).toThrow(`Config file not found: ${path}`);
  });

  it('reports a path that is a directory', () => {
    const dir = makeTempDir();
    const path = join(dir, 'chaos.yml');
    mkdirSync(path);

    expect(() => loadConfigFile(path)).toThrow(`Config path is a directory, not a file: ${path}`);
  });

  it('reports a file it is not allowed to read', () => {
    const path = writeConfig('target: http://localhost:3000\n');
    chmodSync(path, 0o000);

    // Anything running as root can read it anyway, so only assert when the
    // permission actually bites.
    let readable = true;

    try {
      loadConfigFile(path);
    } catch {
      readable = false;
    }

    if (readable) {
      return;
    }

    expect(() => loadConfigFile(path)).toThrow(ConfigError);
    expect(() => loadConfigFile(path)).toThrow(`Config file cannot be read: ${path}`);
  });

  it('reports invalid YAML with the line it failed on, and no source dump', () => {
    const path = writeConfig('target: http://localhost:3000\nrules: [oops\n');

    expect(() => loadConfigFile(path)).toThrow(ConfigError);

    const error = (() => {
      try {
        loadConfigFile(path);
        return undefined;
      } catch (thrown) {
        return thrown as Error;
      }
    })();

    expect(error?.message).toContain(`Could not parse ${path} as YAML`);
    expect(error?.message.split('\n')).toHaveLength(1);
  });

  it('rejects duplicate keys rather than silently keeping one', () => {
    const path = writeConfig('target: http://localhost:3000\ntarget: http://localhost:4000\n');

    expect(() => loadConfigFile(path)).toThrow(/as YAML/);
  });

  it('rejects an empty file', () => {
    const path = writeConfig('');

    expect(() => loadConfigFile(path)).toThrow(/must contain a YAML mapping/);
  });

  it('passes a schema violation straight through', () => {
    const path = writeConfig('target: http://localhost:3000\nfoo: 1\n');

    expect(() => loadConfigFile(path)).toThrow('Invalid config: unknown field "foo".');
  });

  it('accepts a .yaml extension just as readily', () => {
    const path = writeConfig('target: http://localhost:3000\n', 'chaos.yaml');

    expect(loadConfigFile(path).config.target).toBe('http://localhost:3000');
  });
});
