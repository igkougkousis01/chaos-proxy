import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLI_NAME, run } from '../src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('run', () => {
  it('prints the tool name to stdout', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    run();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(CLI_NAME);
  });
});
