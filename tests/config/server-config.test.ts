/**
 * @fileoverview Tests for the server's env config: the optional contact email
 * and 5-minute request budget, their validation errors naming the env var, and
 * the lazy parse being memoized.
 * @module tests/config/server-config.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

const EMAIL = 'DATACITE_CONTACT_EMAIL';
const BUDGET = 'DATACITE_MAX_REQUESTS_PER_5MIN';

/** A fresh module instance, so the lazy parse reads the env stubbed for this test. */
async function loadConfig(env: { budget?: string; email?: string; clamp?: string }) {
  vi.resetModules();
  vi.stubEnv(EMAIL, env.email ?? '');
  vi.stubEnv(BUDGET, env.budget ?? '');
  vi.stubEnv('DATACITE_CLAMP_LIMITS', env.clamp ?? '');
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getServerConfig', () => {
  it.each(['', `\${user_config.datacite_clamp_limits}`, 'true', '1', 'yes', 'on'])(
    'enables clamping for %j',
    async (clamp) => expect((await loadConfig({ clamp }))().clampLimits).toBe(true),
  );
  it.each(['false', '0', 'no', 'off'])('disables clamping for %j', async (clamp) =>
    expect((await loadConfig({ clamp }))().clampLimits).toBe(false),
  );
  it('rejects an invalid switch with the env variable name', async () => {
    const get = await loadConfig({ clamp: 'maybe' });
    expect(() => get()).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining('DATACITE_CLAMP_LIMITS (clampLimits)'),
      }),
    );
  });
  it('advertises strict actual caps and rejects oversized counts with the switch off', async () => {
    await loadConfig({ clamp: 'false' });
    const { z } = await import('@cyanheads/mcp-ts-core');
    const { searchWorksTool } = await import('@/mcp-server/tools/definitions/search-works.tool.js');
    const { searchRepositoriesTool } = await import(
      '@/mcp-server/tools/definitions/search-repositories.tool.js'
    );
    const { traceRelationsTool } = await import(
      '@/mcp-server/tools/definitions/trace-relations.tool.js'
    );
    for (const { tool, field, cap, base } of [
      { tool: searchWorksTool, field: 'limit', cap: 1000, base: {} },
      { tool: searchRepositoriesTool, field: 'limit', cap: 1000, base: {} },
      { tool: traceRelationsTool, field: 'max_nodes', cap: 100, base: { doi: '10.5555/test' } },
    ]) {
      expect(z.toJSONSchema(tool.input, { io: 'input' }).properties?.[field]).toMatchObject({
        maximum: cap,
        minimum: 1,
        multipleOf: 1,
      });
      expect(tool.input.safeParse({ ...base, [field]: cap }).success).toBe(true);
      expect(tool.input.safeParse({ ...base, [field]: cap + 1 }).success).toBe(false);
    }
  });
  it('leaves both settings unset when the env vars are empty', async () => {
    const getServerConfig = await loadConfig({});
    expect(getServerConfig()).toEqual({ clampLimits: true });
  });

  it('reads a valid contact email and an integer budget', async () => {
    const getServerConfig = await loadConfig({ email: 'ops@example.org', budget: '250' });
    expect(getServerConfig()).toEqual({
      contactEmail: 'ops@example.org',
      maxRequestsPer5Min: 250,
      clampLimits: true,
    });
  });

  it.each(['50', '1000'])('accepts the budget bound %s', async (budget) => {
    const getServerConfig = await loadConfig({ budget });
    expect(getServerConfig().maxRequestsPer5Min).toBe(Number(budget));
  });

  it.each(['49', '1001', '12.5', 'lots'])(
    'rejects the budget %j, naming DATACITE_MAX_REQUESTS_PER_5MIN',
    async (budget) => {
      const getServerConfig = await loadConfig({ budget });
      expect(() => getServerConfig()).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.ConfigurationError,
          message: expect.stringContaining(`${BUDGET} (maxRequestsPer5Min)`),
        }),
      );
    },
  );

  it.each(['not-an-email', 'ops@', 'ops@example.org, other@example.org'])(
    'rejects the contact email %j, naming DATACITE_CONTACT_EMAIL',
    async (email) => {
      const getServerConfig = await loadConfig({ email });
      expect(() => getServerConfig()).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.ConfigurationError,
          message: expect.stringContaining(`${EMAIL} (contactEmail)`),
        }),
      );
    },
  );

  it('parses once and serves the memoized result after the env changes', async () => {
    const getServerConfig = await loadConfig({ email: 'ops@example.org' });
    const first = getServerConfig();
    vi.stubEnv(EMAIL, 'other@example.org');
    expect(getServerConfig()).toBe(first);
    expect(getServerConfig().contactEmail).toBe('ops@example.org');
  });
});
