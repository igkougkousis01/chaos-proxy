import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CONVENTIONAL_CONFIG_FILE, resolveConfigPath } from '../../src/config/discover.js';

/**
 * Discovery is the one part of the tool that depends on where the user is
 * standing, so every test here works in a scratch directory of its own and
 * passes it in explicitly. Nothing changes the process's working directory,
 * which keeps these tests independent of every other file.
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** A scratch directory that is removed after the test that made it. */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-proxy-discover-'));
  tempDirs.push(dir);

  return dir;
}

/** Writes `name` inside `dir` and returns its absolute path. */
function writeFile(
  dir: string,
  name: string,
  contents = 'target: http://localhost:3000\n',
): string {
  const path = join(dir, name);
  writeFileSync(path, contents, 'utf8');

  return path;
}

describe('the conventional config file', () => {
  it('is chaos.yml, and only chaos.yml', () => {
    expect(CONVENTIONAL_CONFIG_FILE).toBe('chaos.yml');
  });
});

describe('resolveConfigPath with no --config', () => {
  it('finds ./chaos.yml in the working directory', () => {
    const dir = makeTempDir();
    const path = writeFile(dir, 'chaos.yml');

    expect(resolveConfigPath(undefined, dir)).toBe(path);
  });

  // The ordinary case: most runs have no config file at all, and saying so
  // would be noise rather than news.
  it('reports no config at all when it is not there, rather than failing', () => {
    expect(resolveConfigPath(undefined, makeTempDir())).toBeUndefined();
  });

  // Every one of these is a name someone might reasonably expect to work. They
  // deliberately do not, so that which file is in effect is never a guess.
  it.each(['chaos.yaml', '.chaos.yml', 'chaosproxy.yml', 'chaos.yml.bak', 'chaos.json'])(
    'does not pick up %s',
    (name) => {
      const dir = makeTempDir();
      writeFile(dir, name);

      expect(resolveConfigPath(undefined, dir)).toBeUndefined();
    },
  );

  it('does not look in the parent directory', () => {
    const parent = makeTempDir();
    writeFile(parent, 'chaos.yml');
    const child = join(parent, 'nested');
    mkdirSync(child);

    expect(resolveConfigPath(undefined, child)).toBeUndefined();
  });

  // A convenience should not invent an error: something that cannot be a config
  // file is passed over, and the run continues as if nothing was there.
  it('passes over a directory that happens to be called chaos.yml', () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'chaos.yml'));

    expect(resolveConfigPath(undefined, dir)).toBeUndefined();
  });
});

describe('resolveConfigPath with an explicit --config', () => {
  it('uses the path that was given', () => {
    const dir = makeTempDir();
    const path = writeFile(dir, 'other.yml');

    expect(resolveConfigPath(path, dir)).toBe(path);
  });

  it('resolves a relative path against the working directory', () => {
    const dir = makeTempDir();
    const path = writeFile(dir, 'other.yml');

    expect(resolveConfigPath('./other.yml', dir)).toBe(path);
    expect(resolveConfigPath('other.yml', dir)).toBe(path);
  });

  // Explicit intent wins even over a conventional file sitting right there.
  it('wins over a chaos.yml in the same directory', () => {
    const dir = makeTempDir();
    writeFile(dir, 'chaos.yml');
    const other = writeFile(dir, 'other.yml');

    expect(resolveConfigPath('other.yml', dir)).toBe(other);
  });

  /**
   * The important one. Falling back here would run a configuration the user did
   * not ask for and never mention it, which looks exactly like success.
   */
  it('does not fall back to chaos.yml when the file it names is missing', () => {
    const dir = makeTempDir();
    writeFile(dir, 'chaos.yml');

    expect(resolveConfigPath('./missing.yml', dir)).toBe(resolvePath(dir, 'missing.yml'));
  });

  it('returns a missing path rather than nothing, so loading it can complain', () => {
    const dir = makeTempDir();

    expect(resolveConfigPath('missing.yml', dir)).toBe(join(dir, 'missing.yml'));
  });

  it('returns an absolute path however it was written', () => {
    const dir = makeTempDir();
    writeFile(dir, 'chaos.yml');

    expect(resolveConfigPath('./chaos.yml', dir)).toBe(join(dir, 'chaos.yml'));
  });
});
