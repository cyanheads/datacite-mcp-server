/**
 * @fileoverview Public count contracts: upstream caps, integer schema, and paging.
 * @module tests/mcp-server/tools/definitions/count-limits.test
 */
import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCount } from '@/mcp-server/tools/definitions/_counts.js';
import { searchRepositoriesTool } from '@/mcp-server/tools/definitions/search-repositories.tool.js';
import { searchWorksTool } from '@/mcp-server/tools/definitions/search-works.tool.js';
import { traceRelationsTool } from '@/mcp-server/tools/definitions/trace-relations.tool.js';
import {
  contentText,
  dataCite,
  initServices,
  json,
  requestUrl,
  structured,
  teardownServices,
  toolError,
} from '../../../helpers/harness.js';

afterEach(teardownServices);

const counterAdd = vi.hoisted(() => vi.fn());
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: () => ({ add: counterAdd }),
}));
beforeEach(() => counterAdd.mockClear());

describe('clamp disclosure', () => {
  it.each([
    { requested: 1, cap: 1000, applied: 1 },
    { requested: 1000, cap: 1000, applied: 1000 },
    { requested: 1001, cap: 1000, applied: 1000 },
    { requested: 10001, cap: 1000, applied: 1000 },
    { requested: Number.MAX_VALUE, cap: 1000, applied: 1000 },
    { requested: 10001, cap: 100, applied: 100 },
  ])('discloses $requested → $applied once', ({ requested, cap, applied }) => {
    const ctx = createMockContext();
    const log = vi.spyOn(ctx.log, 'notice');
    const notices: string[] = [];
    expect(applyCount(requested, cap, 'limit', 'datacite_search_works', ctx, notices)).toBe(
      applied,
    );
    if (requested > cap) {
      const message = `Requested limit=${requested}; applied limit=${applied}.`;
      expect(notices).toEqual([message]);
      expect(log).toHaveBeenCalledExactlyOnceWith(message, {
        tool: 'datacite_search_works',
        field: 'limit',
        requested,
        applied,
      });
      expect(counterAdd).toHaveBeenCalledExactlyOnceWith(1, {
        tool: 'datacite_search_works',
        field: 'limit',
      });
    } else {
      expect(notices).toEqual([]);
      expect(log).not.toHaveBeenCalled();
      expect(counterAdd).not.toHaveBeenCalled();
    }
  });
});

const cases = [
  { tool: searchWorksTool, field: 'limit', cap: 1000, fallback: 20, required: {} },
  { tool: searchRepositoriesTool, field: 'limit', cap: 1000, fallback: 20, required: {} },
  {
    tool: traceRelationsTool,
    field: 'max_nodes',
    cap: 100,
    fallback: 50,
    required: { doi: '10.5555/test' },
  },
] as const;

describe('count schemas', () => {
  for (const { tool, field, cap, fallback, required } of cases) {
    it(`${tool.name} advertises an unbounded whole positive count`, () => {
      const schema = z.toJSONSchema(tool.input, { io: 'input' });
      expect(schema.properties?.[field]).toMatchObject({
        minimum: 1,
        multipleOf: 1,
        default: fallback,
      });
      expect(schema.properties?.[field]).not.toHaveProperty('maximum');
      for (const value of [cap, cap + 1, 10001, Number.MAX_VALUE]) {
        expect(tool.input.safeParse({ ...required, [field]: value }).success).toBe(true);
      }
      for (const value of [0, -1, 1.5, 1.0000000000000002, NaN, Infinity, -Infinity]) {
        const parsed = tool.input.safeParse({ ...required, [field]: value });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues).toHaveLength(1);
      }
      for (const value of [undefined, '', '  ']) {
        expect(tool.input.parse({ ...required, [field]: value })).toMatchObject({
          [field]: fallback,
        });
      }
    });
  }
});

describe('search page sizes', () => {
  it('records a graph clamp once and keeps the graph cap at 100', async () => {
    initServices([
      {
        match: dataCite('/dois', (url) => url.searchParams.get('query') === 'doi:"10.5555/test"'),
        respond: json({
          data: [{ id: '10.5555/test', type: 'dois', attributes: { doi: '10.5555/test' } }],
          meta: { total: 1 },
        }),
      },
      { match: dataCite('/dois'), respond: json({ data: [], meta: { total: 0 } }) },
    ]);
    const result = await runToolContract(traceRelationsTool, {
      doi: '10.5555/test',
      max_nodes: 10001,
      include_event_data: false,
    });
    expect(result.isError).toBeFalsy();
    expect(structured<Record<string, unknown>>(result).notice).toContain(
      'Requested max_nodes=10001; applied max_nodes=100.',
    );
    expect(contentText(result)).toContain('Requested max_nodes=10001; applied max_nodes=100.');
    expect(counterAdd).toHaveBeenCalledExactlyOnceWith(1, {
      tool: 'datacite_trace_relations',
      field: 'max_nodes',
    });
  });
  for (const { tool, path, key, type } of [
    { tool: searchWorksTool, path: '/dois', key: 'works', type: 'dois' },
    { tool: searchRepositoriesTool, path: '/repositories', key: 'repositories', type: 'clients' },
  ] as const) {
    it.each([1000, 1001, 10001])(
      `${tool.name} serves the applied upstream size for %s`,
      async (limit) => {
        const rows = Array.from({ length: 1000 }, (_, i) => ({
          id: type === 'dois' ? `10.5555/${i}` : `test.repo${i}`,
          type,
          attributes: {},
        }));
        const { http } = initServices([
          { match: dataCite(path), respond: json({ data: rows, meta: { total: 2001, page: 1 } }) },
        ]);
        const result = await runToolContract(tool, { limit });
        expect(result.isError).toBeFalsy();
        expect(requestUrl(http).searchParams.get('page[size]')).toBe('1000');
        const out = structured<Record<string, unknown>>(result);
        expect(out[key]).toHaveLength(1000);
        expect(out.nextPage).toBe(2);
        expect(contentText(result)).toContain('1000');
        if (limit > 1000) {
          expect(out.notice).toContain(`Requested limit=${limit}; applied limit=1000.`);
          expect(contentText(result)).toContain(`Requested limit=${limit}; applied limit=1000.`);
          expect(counterAdd).toHaveBeenCalledExactlyOnceWith(1, {
            tool: tool.name,
            field: 'limit',
          });
        } else expect(out.notice).toBeUndefined();
      },
    );
  }
  it('uses 1000 for the last ranked page and refuses page 11 before I/O', async () => {
    const { http } = initServices([
      { match: dataCite('/dois'), respond: json({ data: [], meta: { total: 15000, page: 10 } }) },
    ]);
    const result = await runToolContract(searchWorksTool, { limit: 10001, page: 10 });
    expect(result.isError).toBeFalsy();
    expect(requestUrl(http).searchParams.get('page[size]')).toBe('1000');
    expect(structured<Record<string, unknown>>(result).nextPage).toBeUndefined();
    expect(contentText(result)).toContain('cursor');
    const rejected = await runToolContract(searchWorksTool, { limit: 1000, page: 11 });
    expect(toolError(rejected).data?.reason).toBe('page_ceiling');
    expect(contentText(rejected)).toContain('Recovery:');
    expect(http.calls).toHaveLength(1);
  });
});
