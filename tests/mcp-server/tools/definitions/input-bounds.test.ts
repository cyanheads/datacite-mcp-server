/**
 * @fileoverview Length bounds on string inputs across the tool surface: each
 * bounded field advertises its `maxLength` in `inputSchema`, admits a value of
 * exactly that length, and rejects one character more as `invalid_arguments`
 * naming the field before any request. Every free-text string input is bounded.
 * @module tests/mcp-server/tools/definitions/input-bounds.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { getCitationTool } from '@/mcp-server/tools/definitions/get-citation.tool.js';
import { getWorkTool } from '@/mcp-server/tools/definitions/get-work.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { searchRepositoriesTool } from '@/mcp-server/tools/definitions/search-repositories.tool.js';
import { searchWorksTool } from '@/mcp-server/tools/definitions/search-works.tool.js';
import { traceRelationsTool } from '@/mcp-server/tools/definitions/trace-relations.tool.js';
import {
  contentText,
  initServices,
  teardownServices,
  toolError,
} from '../../../helpers/harness.js';

afterEach(teardownServices);

interface StringSchema {
  enum?: unknown[];
  maxLength?: number;
  pattern?: string;
  type?: string;
}

interface PropertySchema extends StringSchema {
  items?: StringSchema;
}

const TOOLS = [
  searchWorksTool,
  getWorkTool,
  traceRelationsTool,
  searchRepositoriesTool,
  getCitationTool,
  listReferenceTool,
] as const;

type Tool = (typeof TOOLS)[number];

/** The `tools/list` input schema, emitted as the SDK emits it, keyed by property. */
const properties = (tool: Tool): Record<string, PropertySchema> =>
  (
    z.toJSONSchema(tool.input, { io: 'input', target: 'draft-2020-12' }) as {
      properties: Record<string, PropertySchema>;
    }
  ).properties;

interface BoundCase {
  /** Whether the field is an array of the bounded string. */
  array?: boolean;
  field: string;
  max: number;
  /** Other inputs the call needs to parse. */
  required?: Record<string, unknown>;
  tool: Tool;
  /** A value of length `n` the field otherwise accepts. */
  value: (n: number) => string;
}

const letters = (n: number) => 'a'.repeat(n);
const doi = (n: number) => `10.1234/${'a'.repeat(n - 8)}`;
const repositoryId = (n: number) => `a.${'b'.repeat(n - 2)}`;
const DOI_INPUT = { doi: '10.5061/dryad.234' };

const CASES: BoundCase[] = [
  { tool: searchWorksTool, field: 'text', max: 2000, value: letters },
  { tool: searchWorksTool, field: 'query', max: 2000, value: letters },
  { tool: searchWorksTool, field: 'creator', max: 500, value: letters },
  { tool: searchWorksTool, field: 'affiliation', max: 500, value: letters },
  { tool: searchWorksTool, field: 'funder', max: 500, value: letters },
  { tool: searchWorksTool, field: 'subject', max: 500, value: letters },
  { tool: searchWorksTool, field: 'place', max: 500, value: letters },
  { tool: searchWorksTool, field: 'cursor', max: 2048, value: letters },
  { tool: searchWorksTool, field: 'repository_ids', array: true, max: 100, value: repositoryId },
  { tool: searchWorksTool, field: 'provider_ids', array: true, max: 100, value: letters },
  { tool: searchWorksTool, field: 'licenses', array: true, max: 100, value: letters },
  { tool: searchRepositoriesTool, field: 'query', max: 2000, value: letters },
  { tool: searchRepositoriesTool, field: 'software', max: 500, value: letters },
  { tool: searchRepositoriesTool, field: 'provider_id', max: 100, value: letters },
  {
    tool: searchRepositoriesTool,
    field: 'repository_ids',
    array: true,
    max: 100,
    value: repositoryId,
  },
  { tool: getWorkTool, field: 'doi', max: 500, value: doi },
  { tool: traceRelationsTool, field: 'doi', max: 500, value: doi },
  { tool: getCitationTool, field: 'doi', max: 500, value: doi },
  { tool: getCitationTool, field: 'style', max: 200, required: DOI_INPUT, value: letters },
];

const label = (c: BoundCase) => `${c.tool.name}.${c.field}`;
const inputFor = (c: BoundCase, n: number) => ({
  ...c.required,
  [c.field]: c.array ? [c.value(n)] : c.value(n),
});

/** Runs any tool definition through its contract boundary with an untyped input. */
const run = (tool: Tool, input: Record<string, unknown>) =>
  runToolContract(tool as typeof searchWorksTool, input as z.input<typeof searchWorksTool.input>);

describe('string input bounds', () => {
  it('bound every string input that advertises neither an enum nor a pattern', () => {
    const unbounded = TOOLS.flatMap((tool) =>
      Object.entries(properties(tool))
        .filter(([, property]) => {
          const string = property.type === 'array' ? property.items : property;
          return (
            string?.type === 'string' &&
            string.enum === undefined &&
            string.pattern === undefined &&
            string.maxLength === undefined
          );
        })
        .map(([field]) => `${tool.name}.${field}`),
    );
    expect(unbounded).toEqual([]);
  });

  it('cover every field that advertises a maxLength', () => {
    const bounded = TOOLS.flatMap((tool) =>
      Object.entries(properties(tool))
        .filter(([, property]) => (property.maxLength ?? property.items?.maxLength) !== undefined)
        .map(([field]) => `${tool.name}.${field}`),
    );
    expect(bounded.sort()).toEqual(CASES.map(label).sort());
  });

  it.each(CASES.map((c) => [label(c), c] as const))(
    '%s advertises its maxLength and admits a value of exactly that length',
    (_name, c) => {
      const property = properties(c.tool)[c.field];
      expect(c.array ? property?.items?.maxLength : property?.maxLength).toBe(c.max);
      expect(c.value(c.max)).toHaveLength(c.max);
      expect(c.tool.input.safeParse(inputFor(c, c.max)).success).toBe(true);
    },
  );

  it.each(CASES.map((c) => [label(c), c] as const))(
    '%s rejects one character more as invalid_arguments before any request',
    async (_name, c) => {
      const { http } = initServices([]);
      const result = await run(c.tool, inputFor(c, c.max + 1));
      const error = toolError(result);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_arguments');
      expect(error.message).toContain(c.field);
      expect(contentText(result)).toContain('(reason invalid_arguments');
      expect(http.calls).toHaveLength(0);
    },
  );
});

describe('slash-run identifiers at the tool boundary', () => {
  const slashes = '/'.repeat(100_000);

  it.each([
    { field: 'creator', prefix: 'orcid.org/' },
    { field: 'affiliation', prefix: 'ror.org/' },
    { field: 'funder', prefix: 'ror.org/' },
  ])(
    'rejects a $field of $prefix plus 100,000 slashes before normalizing it, without blocking or a request',
    async ({ field, prefix }) => {
      const { http } = initServices([]);
      const start = performance.now();
      const result = await run(searchWorksTool, { [field]: `${prefix}${slashes}x` });
      expect(performance.now() - start).toBeLessThan(250);
      const error = toolError(result);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_arguments');
      expect(error.message).toContain(field);
      expect(http.calls).toHaveLength(0);
    },
  );
});
