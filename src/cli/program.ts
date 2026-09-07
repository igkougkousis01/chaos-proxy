import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';

import { ConfigError } from '../config/schema.js';
import { createProxyServer } from '../index.js';
import type { ProxyServerOptions } from '../index.js';
import { formatRequestLog } from './log.js';
import {
  CLI_NAME,
  CliError,
  DISPLAY_NAME,
  HELP_TEXT,
  LISTEN_HOST,
  USAGE_HINT,
  inFlagTerms,
  parseCliArgs,
} from './options.js';
import { resolveCommand } from './resolve.js';
import type { ResolvedCommand } from './resolve.js';

/** Where the CLI writes its output, so tests can capture it without a shell. */
export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** Signals that ask the proxy to stop. */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * Discards informational output, so `--quiet` is expressed in exactly one
 * place: what the CLI has to say still goes to stderr, and everything it merely
 * mentions goes nowhere.
 */
const SILENT: CliIo['out'] = () => {
  // Deliberately empty; see above.
};

const consoleIo: CliIo = {
  out: (text) => {
    console.log(text);
  },
  err: (text) => {
    console.error(text);
  },
};

/**
 * Reads the package version from the manifest that ships with the package.
 *
 * `src/cli/` compiles to `dist/cli/`, so this relative URL resolves to the
 * package root from both the source tree and an installed copy — and
 * `package.json` is always part of a published package. Reading it keeps the
 * version in exactly one place instead of copying it into a source file that
 * would then need to be kept in step with releases.
 */
export function readPackageVersion(): string {
  const manifestUrl = new URL('../../package.json', import.meta.url);
  const manifest: unknown = JSON.parse(readFileSync(manifestUrl, 'utf8'));

  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string'
  ) {
    throw new Error(`Could not read a version from ${manifestUrl.pathname}.`);
  }

  return manifest.version;
}

/** Formats a chaos rate as a percentage, without floating-point noise. */
function asPercentage(rate: number): string {
  return `${Number((rate * 100).toFixed(4))}%`;
}

/**
 * Builds the lines printed once the proxy is listening.
 *
 * Only chaos that is actually switched on is mentioned, and only values the
 * user supplied are shown: the proxy core owns the defaults for `--error-status`
 * and `--timeout`, so repeating them here would be a second copy to keep in
 * step. The chaos shown is what applies to a request no rule matches; per-rule
 * settings are left in the file rather than reprinted.
 *
 * Every chaos line is read off the settled options rather than off whatever
 * asked for them, so a preset a flag has overridden is never described as
 * though it still applied: `--preset flaky-api --error-rate 0` names the preset
 * and then says nothing about error injection, because none happens.
 */
function startupLines(listeningOn: string, command: ResolvedCommand): string[] {
  const { proxy } = command;
  const lines = [`${DISPLAY_NAME} listening on ${listeningOn}`, `Target: ${proxy.target}`];

  // Named before the chaos it contributed, since the lines below are the only
  // place its effect shows and one of them may well have been overridden away.
  if (command.preset !== undefined) {
    lines.push(`Preset: ${command.preset}`);
  }

  // Named rather than summarised: which file is in effect is what someone
  // debugging unexpected chaos needs, and the file itself is right there.
  if (command.configPath !== undefined) {
    lines.push(`Config: ${command.configPath}`);
    lines.push(`Rules: ${command.ruleCount}`);
  }

  if (proxy.latencyMs !== undefined && proxy.latencyMs > 0) {
    lines.push(`Latency: ${proxy.latencyMs}ms`);
  }

  // First of the chaos lines, matching the order the decisions are taken in:
  // a reset is chosen before anything else, and there is no shape to report
  // alongside it — the connection either goes or it does not.
  if (proxy.resetRate !== undefined && proxy.resetRate > 0) {
    lines.push(`Connection resets: ${asPercentage(proxy.resetRate)}`);
  }

  if (proxy.errorRate !== undefined && proxy.errorRate > 0) {
    const status = proxy.errorStatus === undefined ? '' : ` -> ${proxy.errorStatus}`;
    lines.push(`Error injection: ${asPercentage(proxy.errorRate)}${status}`);
  }

  if (proxy.timeoutRate !== undefined && proxy.timeoutRate > 0) {
    const held = proxy.timeoutMs === undefined ? '' : ` -> ${proxy.timeoutMs}ms`;
    lines.push(`Timeout injection: ${asPercentage(proxy.timeoutRate)}${held}`);
  }

  // Last, because it qualifies the rates above rather than adding chaos of its
  // own. A run with no seed says nothing: there is no default to report, and a
  // line about randomness would only be noise on the ordinary path.
  if (command.seed !== undefined) {
    lines.push(`Seed: ${command.seed}`);
  }

  return lines;
}

/** Describes a failure to bind the port in terms the user can act on. */
function describeListenError(error: NodeJS.ErrnoException, port: number): string {
  const where = `${LISTEN_HOST}:${port}`;

  switch (error.code) {
    case 'EADDRINUSE':
      return `port ${port} is already in use on ${LISTEN_HOST}. Choose another port with --port.`;
    case 'EACCES':
      return `not allowed to bind ${where}. Choose a port above 1023 with --port.`;
    default:
      return `could not listen on ${where}: ${error.message}`;
  }
}

/**
 * Starts the proxy and keeps running until it is closed.
 *
 * Resolves with the exit code: `0` once the server has shut down cleanly, or
 * `1` if it never managed to listen.
 */
function listen(server: Server, command: ResolvedCommand, io: CliIo): Promise<number> {
  return new Promise<number>((resolve) => {
    function onStartupError(error: NodeJS.ErrnoException): void {
      io.err(`${CLI_NAME}: ${describeListenError(error, command.port)}`);
      resolve(1);
    }

    server.once('error', onStartupError);

    server.listen(command.port, LISTEN_HOST, () => {
      // Anything failing from here on is no longer a startup problem, so it is
      // left to surface as an unhandled error rather than a usage message.
      server.off('error', onStartupError);

      let closing = false;

      /**
       * Stops accepting new connections and releases idle keep-alive sockets,
       * which would otherwise hold the process open. Requests already in flight
       * are left to finish, and the process exits on its own once they have —
       * no `process.exit()` cutting a response short. A second signal gives up
       * on them.
       */
      function shutdown(signal: NodeJS.Signals): void {
        if (closing) {
          server.closeAllConnections();
          return;
        }

        closing = true;
        io.out(`\nReceived ${signal}, shutting down ${DISPLAY_NAME}.`);
        server.close();
        server.closeIdleConnections();
      }

      // Wired up before anything is printed, so a signal that arrives the
      // instant the proxy announces itself is still handled by us rather than
      // killing the process outright.
      const listeners = SHUTDOWN_SIGNALS.map((signal) => {
        const listener = (): void => {
          shutdown(signal);
        };

        process.on(signal, listener);

        return { signal, listener } as const;
      });

      // Printed from the bound address rather than the requested one, so the
      // message always names what the proxy is really reachable on.
      const address = server.address();
      const listeningOn =
        address !== null && typeof address === 'object'
          ? `http://${address.address}:${address.port}`
          : `http://${LISTEN_HOST}:${command.port}`;

      for (const line of startupLines(listeningOn, command)) {
        io.out(line);
      }

      server.once('close', () => {
        for (const { signal, listener } of listeners) {
          process.off(signal, listener);
        }

        resolve(0);
      });
    });
  });
}

/**
 * The options handed to `createProxyServer`, with request logging attached
 * unless it was switched off.
 *
 * The proxy core is silent on its own and knows nothing about how a line is
 * shaped; this is where its facts become the output a developer reads.
 */
function withRequestLogging(
  proxy: ProxyServerOptions,
  quiet: boolean,
  io: CliIo,
): ProxyServerOptions {
  if (quiet) {
    return proxy;
  }

  return {
    ...proxy,
    onRequestComplete: (event) => {
      io.out(formatRequestLog(event, new Date()));
    },
  };
}

/**
 * Runs the CLI and resolves with the process exit code.
 *
 * Expected problems — a usage mistake, an unusable config file, an option the
 * proxy core rejects, or a port that cannot be bound — are reported as a single
 * line and a non-zero code. Anything else is left to propagate, so a real
 * defect still shows its stack trace.
 *
 * `--quiet` suppresses informational output only — the startup summary, the
 * per-request lines, and the shutdown notice. Every error still goes to stderr,
 * and `--help` and `--version` still print what they were asked for.
 */
export async function runCli(argv: readonly string[], io: CliIo = consoleIo): Promise<number> {
  function reportUsageError(message: string): number {
    io.err(`${CLI_NAME}: ${message}`);
    io.err(USAGE_HINT);

    return 1;
  }

  let command: ResolvedCommand;
  let quiet: boolean;

  try {
    const parsed = parseCliArgs(argv);

    if (parsed.kind === 'help') {
      io.out(HELP_TEXT);
      return 0;
    }

    if (parsed.kind === 'version') {
      io.out(readPackageVersion());
      return 0;
    }

    quiet = parsed.command.quiet;
    command = resolveCommand(parsed.command);
  } catch (error) {
    if (error instanceof CliError || error instanceof ConfigError) {
      return reportUsageError(error.message);
    }

    throw error;
  }

  // Errors keep their stream; only what the CLI would otherwise volunteer is
  // dropped, so a quiet run that fails still says why.
  const runIo: CliIo = quiet ? { out: SILENT, err: io.err } : io;
  let server: Server;

  try {
    server = createProxyServer(withRequestLogging(command.proxy, quiet, runIo));
  } catch (error) {
    // The proxy core is the authority on what its options may contain; the CLI
    // only translates its complaint back into the flag that carried the value.
    if (error instanceof TypeError || error instanceof RangeError) {
      return reportUsageError(inFlagTerms(error.message));
    }

    throw error;
  }

  return await listen(server, command, runIo);
}
