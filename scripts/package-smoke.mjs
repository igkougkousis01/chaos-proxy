#!/usr/bin/env node
/**
 * Verifies the packed package the way a stranger receives it.
 *
 * `npm test` proves the code works in this repository, where `src/`, `tests/`
 * and `node_modules/` are all present. None of that reaches a consumer: they
 * get a tarball. Everything that can only break between those two situations —
 * a `bin` entry pointing at a file that was never packed, a shebang lost in
 * transit, an `exports` map that does not resolve, an import that reaches back
 * into `src/` — is invisible to the test suite and fatal to the first person
 * who installs it.
 *
 * So this packs the package, installs it into a throwaway project outside the
 * repository, and drives the installed copy: the CLI as a child process, the
 * public API as an import, and a real request forwarded through a real proxy.
 * Nothing here reads a file from this repository once the tarball exists.
 *
 * It is deliberately a Node script rather than a shell script, because it runs
 * on macOS and Linux in CI and on whatever a contributor happens to use.
 */

import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createRawServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

/** How long any single wait here may take before it counts as a failure. */
const WAIT_TIMEOUT_MS = 60_000;

/**
 * The command the package installs, which is deliberately not the package name.
 *
 * The package is scoped — `@igkougkousis/chaos-proxy` — because the unscoped
 * registry name belongs to someone else. `bin` names are not namespaced, so the
 * executable a consumer gets is still `chaos-proxy`. Every lookup below that
 * concerns the binary uses this rather than the manifest name, and the checks
 * assert the two differ rather than quietly assuming they match.
 */
const BIN_NAME = 'chaos-proxy';

/** Files the package must contain, because a consumer cannot work without them. */
const REQUIRED_ENTRIES = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/cli.js',
  'dist/index.js',
  'dist/index.d.ts',
  'examples/chaos.yml',
];

/**
 * Directories that must not be in the package.
 *
 * Shipping any of them would mean the tarball is carrying the repository rather
 * than the product, and — worse for `src/` — that a broken `dist/` could be
 * masked by source files a consumer was never meant to run.
 */
const FORBIDDEN_PREFIXES = ['src/', 'tests/', '.github/', 'coverage/', 'docs/'];

let failures = 0;

function pass(what) {
  console.log(`  ok  ${what}`);
}

function fail(what, detail) {
  failures += 1;
  console.log(`FAIL  ${what}`);
  console.log(`      ${detail}`);
}

function check(what, condition, detail) {
  if (condition) {
    pass(what);
  } else {
    fail(what, detail);
  }
}

function step(name) {
  console.log(`\n${name}`);
}

/**
 * Runs a command to completion and captures its output.
 *
 * `npm` is a shell script on POSIX and a `.cmd` on Windows, so it is spawned
 * through the platform's own resolution rather than assumed to be an
 * executable of a fixed name.
 */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** The same, but a non-zero exit is a hard stop rather than a result. */
async function runOrThrow(command, args, options) {
  const result = await run(command, args, options);

  if (result.code !== 0) {
    throw new Error(
      `\`${command} ${args.join(' ')}\` exited ${result.code}\n${result.stdout}${result.stderr}`,
    );
  }

  return result;
}

/** A port nothing is listening on, asked of the operating system rather than guessed. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createRawServer();

    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

/** Every file in a directory tree, as package-relative POSIX paths. */
async function listFiles(root, prefix = '') {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      files.push(...(await listFiles(join(root, entry.name), path)));
    } else {
      files.push(path);
    }
  }

  return files;
}

/** A GET through the proxy, reported as status plus body. */
function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, body });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/** Starts the installed CLI and waits until it says it is listening. */
function startProxy(cliPath, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not start within ${WAIT_TIMEOUT_MS}ms\n${stdout}${stderr}`));
    }, WAIT_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdout.on('data', (chunk) => {
      stdout += chunk;

      if (stdout.includes('listening on')) {
        clearTimeout(timer);
        resolve({ child, output: () => stdout + stderr });
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`CLI exited ${code} before listening\n${stdout}${stderr}`));
    });
  });
}

/** Sends a signal and reports the exit code, so a clean shutdown is provable. */
function stopProxy(child, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit within ${WAIT_TIMEOUT_MS}ms of ${signal}`));
    }, WAIT_TIMEOUT_MS);

    child.removeAllListeners('exit');
    child.on('exit', (code, exitSignal) => {
      clearTimeout(timer);
      resolve({ code, signal: exitSignal });
    });

    child.kill(signal);
  });
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), 'chaos-proxy-smoke-'));
  const consumer = join(workspace, 'consumer');
  let proxy;
  let upstream;

  try {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    const { name, version } = manifest;

    step(`Packing ${name}@${version}`);

    // The tarball is written into the throwaway workspace rather than the
    // repository, so a failed run cannot leave a `.tgz` behind in the tree.
    //
    // The filename comes from `--json` rather than from the last line of
    // stdout, because for a scoped package it is not derivable from the name
    // by any rule worth encoding here: npm flattens the scope, so
    // `@igkougkousis/chaos-proxy` packs as
    // `igkougkousis-chaos-proxy-1.0.2.tgz`. npm already knows what it wrote;
    // asking it is the only answer that cannot drift. The scope correction in
    // `1.0.2` changed that filename and this script needed no edit, which is
    // the argument for asking rather than constructing, made once in anger.
    const packed = await runOrThrow('npm', ['pack', '--json', '--pack-destination', workspace], {
      cwd: repoRoot,
    });

    // `prepack` output goes to stderr under `--json`, but slicing from the
    // opening bracket costs nothing and survives an npm that decides otherwise.
    const [packResult] = JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[')));
    const tarball = join(workspace, basename(packResult.filename));

    check(
      'npm pack reports the package it was asked for',
      packResult.name === name && packResult.version === version,
      `npm pack reported ${packResult.name}@${packResult.version}`,
    );
    pass(`packed to ${relative(workspace, tarball)}`);

    step('Installing the tarball into an empty project');

    await mkdir(consumer, { recursive: true });
    await writeFile(
      join(consumer, 'package.json'),
      `${JSON.stringify(
        { name: 'chaos-proxy-consumer', version: '0.0.0', private: true, type: 'module' },
        null,
        2,
      )}\n`,
    );

    await runOrThrow('npm', ['install', tarball, '--no-audit', '--no-fund'], { cwd: consumer });
    pass('npm install succeeded with no repository on the path');

    const installed = join(consumer, 'node_modules', name);

    step('Package contents');

    const shipped = await listFiles(installed);

    for (const required of REQUIRED_ENTRIES) {
      check(
        `contains ${required}`,
        shipped.includes(required),
        `not found in ${shipped.length} shipped files`,
      );
    }

    for (const prefix of FORBIDDEN_PREFIXES) {
      const leaked = shipped.filter((file) => file.startsWith(prefix));
      check(`does not ship ${prefix}`, leaked.length === 0, `found ${leaked.join(', ')}`);
    }

    const maps = shipped.filter((file) => file.endsWith('.map'));
    check(
      'does not ship source maps without sources',
      maps.length === 0,
      `found ${maps.join(', ')}`,
    );

    step('Binary entry');

    const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));

    // The distinction this whole section exists to hold: what the registry
    // calls the package and what the shell calls the command are two different
    // names, and only the first one is scoped.
    check(
      `the installed package is ${name}`,
      installedManifest.name === name,
      `installed manifest says ${installedManifest.name}`,
    );
    check(
      `the installed command is ${BIN_NAME}, not the package name`,
      Object.keys(installedManifest.bin ?? {}).length === 1 &&
        BIN_NAME in (installedManifest.bin ?? {}) &&
        BIN_NAME !== name,
      `bin is ${JSON.stringify(installedManifest.bin)} for package ${name}`,
    );

    const binRelative = installedManifest.bin[BIN_NAME];
    check(
      `bin declares ${BIN_NAME}`,
      typeof binRelative === 'string',
      `bin is ${JSON.stringify(installedManifest.bin)}`,
    );

    const cliPath = join(installed, binRelative);
    const cliSource = await readFile(cliPath, 'utf8').catch(() => null);
    check(`bin target ${binRelative} exists`, cliSource !== null, `${cliPath} could not be read`);
    check(
      'bin target starts with a node shebang',
      cliSource !== null && cliSource.startsWith('#!/usr/bin/env node\n'),
      `first line is ${JSON.stringify(cliSource?.split('\n')[0])}`,
    );

    // Scoped or not, the shim npm writes is named after the `bin` key, so this
    // is what a consumer actually types.
    const shims = await listFiles(join(consumer, 'node_modules', '.bin')).catch(() => []);
    check(
      `node_modules/.bin has a ${BIN_NAME} shim`,
      shims.some((shim) => shim === BIN_NAME || shim.startsWith(`${BIN_NAME}.`)),
      `found ${shims.join(', ') || 'nothing'}`,
    );

    step('Installed CLI');

    const help = await run(process.execPath, [cliPath, '--help'], { cwd: consumer });
    check('--help exits 0', help.code === 0, `exit ${help.code}: ${help.stderr}`);
    check('--help describes the tool', help.stdout.includes('--target'), help.stdout.slice(0, 200));

    const reportedVersion = await run(process.execPath, [cliPath, '--version'], { cwd: consumer });
    check(
      '--version exits 0',
      reportedVersion.code === 0,
      `exit ${reportedVersion.code}: ${reportedVersion.stderr}`,
    );
    check(
      `--version reports ${version}`,
      reportedVersion.stdout.trim() === version,
      `reported ${JSON.stringify(reportedVersion.stdout.trim())}`,
    );

    step('Programmatic import');

    const importProbe = join(consumer, 'import-probe.mjs');
    await writeFile(
      importProbe,
      [
        `import { createProxyServer } from '${name}';`,
        '',
        'if (typeof createProxyServer !== "function") {',
        '  throw new Error("createProxyServer is not a function");',
        '}',
        '',
        'const server = createProxyServer({ target: "http://127.0.0.1:1" });',
        '',
        'if (typeof server.listen !== "function") {',
        '  throw new Error("createProxyServer did not return a server");',
        '}',
        '',
        'console.log("import ok");',
        '',
      ].join('\n'),
    );

    const imported = await run(process.execPath, [importProbe], { cwd: consumer });
    check(
      `import { createProxyServer } from '${name}' resolves`,
      imported.code === 0 && imported.stdout.includes('import ok'),
      `exit ${imported.code}: ${imported.stderr}`,
    );

    step('Forwarding a real request');

    upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('upstream ok');
    });

    const upstreamPort = await freePort();
    await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));

    const healthyPort = await freePort();
    proxy = await startProxy(
      cliPath,
      ['--target', `http://127.0.0.1:${upstreamPort}`, '--port', String(healthyPort)],
      consumer,
    );

    const forwarded = await get(healthyPort, '/api/users');
    check('a healthy request is forwarded', forwarded.status === 200, `status ${forwarded.status}`);
    check(
      'the upstream body arrives intact',
      forwarded.body === 'upstream ok',
      `body ${JSON.stringify(forwarded.body)}`,
    );

    const stopped = await stopProxy(proxy.child, 'SIGINT');
    proxy = undefined;
    check('SIGINT exits 0', stopped.code === 0, `exit ${stopped.code}, signal ${stopped.signal}`);

    step('Injecting a failure');

    const chaosPort = await freePort();
    proxy = await startProxy(
      cliPath,
      [
        '--target',
        `http://127.0.0.1:${upstreamPort}`,
        '--port',
        String(chaosPort),
        '--error-rate',
        '1',
        '--error-status',
        '503',
        '--seed',
        'package-smoke',
      ],
      consumer,
    );

    const injected = await get(chaosPort, '/api/orders');
    check('an injected error answers 503', injected.status === 503, `status ${injected.status}`);

    const stoppedAfterChaos = await stopProxy(proxy.child, 'SIGTERM');
    proxy = undefined;
    check('SIGTERM exits 0', stoppedAfterChaos.code === 0, `exit ${stoppedAfterChaos.code}`);
  } finally {
    if (proxy !== undefined) {
      proxy.child.kill('SIGKILL');
    }

    if (upstream !== undefined) {
      await new Promise((resolve) => upstream.close(resolve));
    }

    await rm(workspace, { recursive: true, force: true });
  }

  console.log('');

  if (failures > 0) {
    console.error(`package smoke test failed: ${failures} check(s) did not pass`);
    process.exitCode = 1;
    return;
  }

  console.log('package smoke test passed');
}

await main();
