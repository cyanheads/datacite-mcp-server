/**
 * @fileoverview Tests for the entry point `src/index.ts`: the options it hands
 * `createApp` — identity, the six tools, no resources or prompts, stateless
 * sessions, server instructions — and the `setup` / `teardown` hooks that wire
 * and dispose the upstream services. `createApp` is replaced so no transport
 * starts.
 * @module tests/index.test
 */

import type { CreateAppOptions } from '@cyanheads/mcp-ts-core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDataCiteService } from '@/services/datacite/datacite-service.js';
import { getRegistrationAgencyService } from '@/services/doi-ra/doi-ra-service.js';

const createApp = vi.hoisted(() => vi.fn());

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp,
}));

const TOOL_NAMES = [
  'datacite_search_works',
  'datacite_get_work',
  'datacite_trace_relations',
  'datacite_search_repositories',
  'datacite_get_citation',
  'datacite_list_reference',
];

let options: CreateAppOptions;

beforeAll(async () => {
  await import('@/index.js');
  expect(createApp).toHaveBeenCalledTimes(1);
  options = createApp.mock.calls[0]?.[0] as CreateAppOptions;
});

afterEach(() => {
  options.teardown?.({} as never);
  vi.unstubAllEnvs();
});

describe('createApp options', () => {
  it('names the server by its repository name on both identity fields and sets no others', () => {
    expect(options.name).toBe('datacite-mcp-server');
    expect(options.title).toBe('datacite-mcp-server');
    expect(Object.keys(options).sort()).toEqual([
      'instructions',
      'name',
      'prompts',
      'resources',
      'sessionMode',
      'setup',
      'teardown',
      'title',
      'tools',
    ]);
  });

  it('registers the six tools and no resources or prompts', () => {
    expect(options.tools?.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    expect(options.resources).toEqual([]);
    expect(options.prompts).toEqual([]);
  });

  it('runs stateless', () => {
    expect(options.sessionMode).toBe('stateless');
  });

  it('orients with instructions under 2,048 characters that name every tool', () => {
    const instructions = options.instructions ?? '';
    expect(instructions.length).toBeGreaterThan(0);
    expect(instructions.length).toBeLessThan(2048);
    for (const name of TOOL_NAMES) expect(instructions).toContain(name);
  });
});

describe('lifecycle hooks', () => {
  it('wires both services in setup and disposes them in teardown', () => {
    vi.stubEnv('DATACITE_CONTACT_EMAIL', '');
    vi.stubEnv('DATACITE_MAX_REQUESTS_PER_5MIN', '');
    expect(() => getDataCiteService()).toThrow('DataCiteService not initialized');

    options.setup?.({} as never);
    expect(getDataCiteService()).toBeDefined();
    expect(getRegistrationAgencyService()).toBeDefined();

    options.teardown?.({} as never);
    expect(() => getDataCiteService()).toThrow('DataCiteService not initialized');
    expect(() => getRegistrationAgencyService()).toThrow(
      'RegistrationAgencyService not initialized',
    );
  });
});
