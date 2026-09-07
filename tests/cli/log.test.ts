import { describe, expect, it } from 'vitest';

import { formatRequestLog, formatTimestamp } from '../../src/cli/log.js';
import type { RequestLogEvent } from '../../src/index.js';

/**
 * A fixed local instant, so the timestamp in every expectation below is exact
 * rather than approximate. Constructed from local parts deliberately: the CLI
 * prints local wall-clock time, and a UTC instant would print differently
 * depending on where the tests run.
 */
const AT = new Date(2026, 0, 2, 12, 41, 3);

/** One completion event, with only the fields a test cares about overridden. */
function event(overrides: Partial<RequestLogEvent> = {}): RequestLogEvent {
  return {
    method: 'GET',
    pathname: '/api/users',
    statusCode: 200,
    durationMs: 42,
    outcome: 'forwarded',
    latencyMs: 0,
    ...overrides,
  };
}

describe('formatTimestamp', () => {
  it('prints local wall-clock time as HH:MM:SS', () => {
    expect(formatTimestamp(AT)).toBe('12:41:03');
  });

  it('pads every field to two digits', () => {
    expect(formatTimestamp(new Date(2026, 0, 2, 9, 5, 7))).toBe('09:05:07');
  });

  it('prints midnight rather than 24:00:00', () => {
    expect(formatTimestamp(new Date(2026, 0, 2, 0, 0, 0))).toBe('00:00:00');
  });
});

describe('formatRequestLog', () => {
  it('prints a forwarded request', () => {
    expect(formatRequestLog(event(), AT)).toBe('12:41:03 GET    /api/users -> 200 42ms forwarded');
  });

  it('says nothing about latency when none was applied', () => {
    expect(formatRequestLog(event(), AT)).not.toContain('latency');
  });

  it('appends the effective latency when there was some', () => {
    const line = formatRequestLog(
      event({ pathname: '/api/profile', durationMs: 548, latencyMs: 500 }),
      AT,
    );

    expect(line).toBe('12:41:03 GET    /api/profile -> 200 548ms forwarded latency:+500ms');
  });

  it('prints an injected error with its status and outcome', () => {
    const line = formatRequestLog(
      event({
        method: 'POST',
        pathname: '/api/payments/123',
        statusCode: 503,
        durationMs: 510,
        outcome: 'injected:error',
      }),
      AT,
    );

    expect(line).toBe('12:41:03 POST   /api/payments/123 -> 503 510ms injected:error');
  });

  it('prints an injected error that also waited out a latency delay', () => {
    const line = formatRequestLog(
      event({
        method: 'POST',
        pathname: '/api/orders',
        statusCode: 503,
        durationMs: 520,
        outcome: 'injected:error',
        latencyMs: 500,
      }),
      AT,
    );

    expect(line).toBe('12:41:03 POST   /api/orders -> 503 520ms injected:error latency:+500ms');
  });

  it('prints an injected timeout as a 504', () => {
    const line = formatRequestLog(
      event({
        pathname: '/api/search',
        statusCode: 504,
        durationMs: 2104,
        outcome: 'injected:timeout',
      }),
      AT,
    );

    expect(line).toBe('12:41:03 GET    /api/search -> 504 2104ms injected:timeout');
  });

  it('prints an unreachable upstream as a 502', () => {
    const line = formatRequestLog(
      event({ statusCode: 502, durationMs: 3, outcome: 'upstream:error' }),
      AT,
    );

    expect(line).toBe('12:41:03 GET    /api/users -> 502 3ms upstream:error');
  });

  it('rounds fractional durations and latencies to whole milliseconds', () => {
    expect(formatRequestLog(event({ durationMs: 41.6, latencyMs: 0.4 }), AT)).toBe(
      '12:41:03 GET    /api/users -> 200 42ms forwarded latency:+0ms',
    );
  });

  it('lets a long method push its own line out rather than padding every other', () => {
    expect(formatRequestLog(event({ method: 'OPTIONS' }), AT)).toBe(
      '12:41:03 OPTIONS /api/users -> 200 42ms forwarded',
    );
  });

  it('never truncates a long path', () => {
    const pathname = `/api/${'segment/'.repeat(20)}end`;

    expect(formatRequestLog(event({ pathname }), AT)).toContain(pathname);
  });
});
