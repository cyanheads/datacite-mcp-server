/**
 * @fileoverview What an upstream failure puts on the wire: its status, never the
 * upstream's response body. Covers a content-negotiation 5xx on every attempt
 * (`render_failed`), a search 400 that is not a query parse error, and a doi.org
 * 404 page, each on both `structuredContent` and `content[]`, plus the query
 * parse-error classification that still reads the body server-side.
 * @module tests/mcp-server/tools/definitions/upstream-errors.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCitationTool } from '@/mcp-server/tools/definitions/get-citation.tool.js';
import { getWorkTool } from '@/mcp-server/tools/definitions/get-work.tool.js';
import { searchRepositoriesTool } from '@/mcp-server/tools/definitions/search-repositories.tool.js';
import { searchWorksTool } from '@/mcp-server/tools/definitions/search-works.tool.js';
import { emptyDoiList, fixtureResponse } from '../../../helpers/fixtures.js';
import {
  contentText,
  dataCite,
  doiRa,
  initServices,
  json,
  type ToolResultLike,
  teardownServices,
  text,
  toolError,
} from '../../../helpers/harness.js';

afterEach(() => {
  teardownServices();
  vi.useRealTimers();
});

/** Planted in every upstream error body below; it must reach neither surface. */
const MARKER = 'SECRET-MARKER';

/** The tool error, after asserting the upstream body reached neither client surface. */
function expectNoUpstreamBody(result: ToolResultLike) {
  const error = toolError(result);
  expect(error.data).not.toHaveProperty('body');
  expect(error.data).not.toHaveProperty('responseBody');
  expect(JSON.stringify(result.structuredContent)).not.toContain(MARKER);
  expect(contentText(result)).not.toContain(MARKER);
  return error;
}

describe('upstream error bodies stay off the wire', () => {
  it('keeps a negotiation 5xx body out of render_failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const doi = '10.5061/dryad.8515';
    const { http } = initServices([
      {
        match: dataCite(`/dois/application/vnd.codemeta.ld+json/${encodeURIComponent(doi)}`),
        respond: () =>
          json(
            {
              errors: [
                {
                  status: '500',
                  title: `undefined method 'to_s' for nil at /home/app/webapp/app/models/doi.rb:412 ${MARKER}`,
                },
              ],
            },
            { status: 500, statusText: 'Internal Server Error' },
          ),
      },
    ]);
    const pending = runToolContract(getCitationTool, { doi, format: 'codemeta' });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    const error = expectNoUpstreamBody(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'render_failed',
      status: 500,
      statusText: 'Internal Server Error',
      retryable: true,
    });
    expect(contentText(result)).toContain('(reason render_failed · retryable)');
    expect(http.calls).toHaveLength(3);
  });

  it.each([
    { tool: searchWorksTool, path: '/dois' },
    { tool: searchRepositoriesTool, path: '/repositories' },
  ] as const)(
    'keeps a $path 400 body out of the error when it is not a query parse error',
    async ({ tool, path }) => {
      const { http } = initServices([
        {
          match: dataCite(path),
          respond: () =>
            json(
              {
                errors: [
                  {
                    status: '400',
                    title: `search_phase_execution_exception: [es-node-7.internal:9200] shard failure ${MARKER}`,
                  },
                ],
              },
              { status: 400 },
            ),
        },
      ]);
      const result = await runToolContract(tool, { query: 'glacier' });
      const error = expectNoUpstreamBody(result);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message).toBe('DataCite returned HTTP 400.');
      expect(error.data?.reason).toBeUndefined();
      expect(contentText(result)).toContain('Error: DataCite returned HTTP 400.');
      expect(http.calls).toHaveLength(1);
    },
  );

  it('keeps a doi.org 404 page out of the error', async () => {
    const doi = '10.1038/nature12373';
    initServices([
      { match: dataCite('/dois'), respond: json(emptyDoiList()) },
      {
        match: doiRa(doi),
        respond: () =>
          text(`<!DOCTYPE html><html><title>404 Page not found</title><p>${MARKER}</p></html>`, {
            status: 404,
            headers: { 'content-type': 'text/html' },
          }),
      },
    ]);
    const result = await runToolContract(getWorkTool, { doi });
    const error = expectNoUpstreamBody(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toBe('doi.org returned HTTP 404.');
    expect(error.data).toMatchObject({ status: 404 });
  });

  it('still reads a 400 parse_exception as invalid_query with its position', async () => {
    const { http } = initServices([
      {
        match: dataCite('/dois'),
        respond: fixtureResponse('datacite/errors/parse-exception-query.json', { status: 400 }),
      },
    ]);
    const result = await runToolContract(searchWorksTool, { query: 'titles.title:(glacier' });
    const error = toolError(result);
    expect(error.data?.reason).toBe('invalid_query');
    expect(error.message).toContain('(line 1, column 12)');
    expect(contentText(result)).toContain('(line 1, column 12)');
    expect(JSON.stringify(result.structuredContent)).not.toContain('Was expecting');
    expect(http.calls).toHaveLength(1);
  });
});
