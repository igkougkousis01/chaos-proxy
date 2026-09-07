/**
 * Turns request completion events into the lines the CLI prints for them.
 *
 * The proxy core reports facts and this is the only place they become text, so
 * the shape of a log line can be changed — or checked, in a test — without
 * going anywhere near the forwarding path. None of it is exported from the
 * package: the event is public API, how this tool happens to render it is not.
 */

import type { RequestLogEvent } from '../proxy/server.js';

/**
 * Width the method is padded to, so paths line up for the methods a REST API
 * actually uses. A longer method pushes its own line out rather than widening
 * every other line to accommodate it.
 */
const METHOD_WIDTH = 6;

/**
 * Shown in the status column for a request that never received a status.
 *
 * A connection reset is a transport failure rather than an HTTP one, so the
 * column says so in words. Any number here — `0`, `499`, `444` — would read as
 * a status the client was sent, which is exactly what did not happen.
 */
const NO_STATUS = 'RESET';

/** Two-digit clock field, for example `07`. */
function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Local wall-clock time as `HH:MM:SS`.
 *
 * No date, no timezone handling and no formatting library: these lines are read
 * next to a terminal clock while something is being reproduced, so the seconds
 * are the part that matters and anything more is noise.
 */
export function formatTimestamp(at: Date): string {
  return `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}:${twoDigits(at.getSeconds())}`;
}

/**
 * One completed request as a line of output.
 *
 * The timestamp is passed in rather than read here, so the formatting is a pure
 * function and can be checked against a fixed instant.
 *
 * ```text
 * 12:41:03 GET    /api/users -> 200 42ms forwarded
 * 12:41:15 POST   /api/orders -> 503 520ms injected:error latency:+500ms
 * 12:41:18 GET    /api/cart -> RESET 12ms connection:reset
 * ```
 *
 * Durations are rounded to whole milliseconds; sub-millisecond precision says
 * nothing useful about a network round trip. Latency is mentioned only when
 * some was actually applied, so an ordinary request stays short.
 */
export function formatRequestLog(event: RequestLogEvent, at: Date): string {
  const parts = [
    formatTimestamp(at),
    event.method.padEnd(METHOD_WIDTH),
    event.pathname,
    '->',
    event.statusCode === null ? NO_STATUS : String(event.statusCode),
    `${Math.round(event.durationMs)}ms`,
    event.outcome,
  ];

  if (event.latencyMs > 0) {
    parts.push(`latency:+${Math.round(event.latencyMs)}ms`);
  }

  return parts.join(' ');
}
