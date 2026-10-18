/**
 * @fileoverview Parity between each identifier pattern a tool advertises in its
 * `inputSchema` and the input its schema accepts. A client that validates the
 * raw arguments against the JSON Schema must admit every form the server
 * accepts — any case, surrounding whitespace — and still reject the forms the
 * server rejects.
 * @module tests/mcp-server/tools/definitions/advertised-patterns.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { getCitationTool } from '@/mcp-server/tools/definitions/get-citation.tool.js';
import { getWorkTool } from '@/mcp-server/tools/definitions/get-work.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { searchRepositoriesTool } from '@/mcp-server/tools/definitions/search-repositories.tool.js';
import { searchWorksTool } from '@/mcp-server/tools/definitions/search-works.tool.js';
import { traceRelationsTool } from '@/mcp-server/tools/definitions/trace-relations.tool.js';

interface ToolLike {
  input: z.ZodType;
  name: string;
}

interface PropertySchema {
  items?: { pattern?: string };
  pattern?: string;
}

const TOOLS: ToolLike[] = [
  searchWorksTool,
  getWorkTool,
  traceRelationsTool,
  searchRepositoriesTool,
  getCitationTool,
  listReferenceTool,
];

/**
 * The `tools/list` input schema, emitted the way the SDK emits it
 * (`io: 'input'`, draft 2020-12), keyed by property.
 */
const properties = (tool: ToolLike): Record<string, PropertySchema> =>
  (
    z.toJSONSchema(tool.input, { io: 'input', target: 'draft-2020-12' }) as {
      properties: Record<string, PropertySchema>;
    }
  ).properties;

/** The advertised pattern of `field` (or of its array items), compiled as ajv compiles it. */
function advertisedPattern(tool: ToolLike, field: string): RegExp {
  const property = properties(tool)[field];
  const pattern = property?.pattern ?? property?.items?.pattern;
  if (pattern === undefined) throw new Error(`${tool.name}.${field} advertises no pattern`);
  return new RegExp(pattern, 'u');
}

interface PatternCase {
  /** Server-accepted raw values. */
  accepted: string[];
  /** Whether the field is an array of the patterned string. */
  array?: boolean;
  field: string;
  /** Values the server rejects at the schema. */
  rejected: string[];
  /** Other required input. */
  required?: Record<string, unknown>;
  tool: ToolLike;
}

const DOI_ACCEPTED = [
  '10.5061/dryad.234',
  '  10.5061/DRYAD.234  ',
  'doi:10.5061/dryad.234',
  'DOI: 10.5061/dryad.234',
  'info:doi/10.5061/dryad.234',
  'INFO:DOI/10.5061/dryad.234',
  'https://doi.org/10.5061/dryad.234',
  'HTTPS://DOI.ORG/10.5061/dryad.234',
  'Http://Dx.Doi.Org/10.5061/dryad.234',
  '10.5061%2Fdryad.234',
];
const DOI_REJECTED = [
  'dryad.234',
  'urn:doi:10.5061/dryad.234',
  'https://example.org/10.5061/dryad.234',
  '10.5061/a b',
];

const CASES: PatternCase[] = [
  {
    tool: searchWorksTool,
    field: 'affiliation_country',
    accepted: ['DE', 'us', ' DE ', '\tch\n'],
    rejected: ['DEU', 'Germany', 'D E'],
  },
  {
    tool: searchWorksTool,
    field: 'language',
    accepted: ['en', 'DE', ' fr '],
    rejected: ['eng', 'English'],
  },
  {
    tool: searchWorksTool,
    field: 'licenses',
    array: true,
    accepted: ['cc-by-4.0', 'MIT', ' CC0-1.0 ', 'CC0 1.0', 'cc by 4.0', '\tCC0  1.0\n'],
    rejected: ['cc,by', 'cc/by', 'cc\nby'],
  },
  {
    tool: searchWorksTool,
    field: 'cursor',
    accepted: ['*', ' * ', ' MTMx_Az-9 '],
    rejected: ['not a cursor', '**', 'a.b'],
  },
  {
    tool: searchWorksTool,
    field: 'repository_ids',
    array: true,
    accepted: ['dryad.dryad', ' ETHZ.WGMS ', 'cern.zenodo-2'],
    rejected: ['dryad', 'a.b.c', 'a_b.c'],
  },
  {
    tool: searchWorksTool,
    field: 'provider_ids',
    array: true,
    accepted: ['dryad', ' KADQ ', 'tib-x'],
    rejected: ['ethz.wgms', 'a b'],
  },
  {
    tool: searchRepositoriesTool,
    field: 'provider_id',
    accepted: ['dryad', ' TIB-X '],
    rejected: ['dryad.dryad', 'dry ad'],
  },
  {
    tool: searchRepositoriesTool,
    field: 'repository_ids',
    array: true,
    accepted: ['dryad.dryad', ' ETHZ.WGMS '],
    rejected: ['dryad', 'dryad.dryad.x'],
  },
  { tool: getWorkTool, field: 'doi', accepted: DOI_ACCEPTED, rejected: DOI_REJECTED },
  { tool: traceRelationsTool, field: 'doi', accepted: DOI_ACCEPTED, rejected: DOI_REJECTED },
  { tool: getCitationTool, field: 'doi', accepted: DOI_ACCEPTED, rejected: DOI_REJECTED },
  {
    tool: getCitationTool,
    field: 'style',
    required: { doi: '10.5061/dryad.234' },
    accepted: ['apa', ' IEEE ', 'chicago-author-date'],
    rejected: ['apa 7', 'harvard/x'],
  },
  {
    tool: getCitationTool,
    field: 'locale',
    required: { doi: '10.5061/dryad.234' },
    accepted: ['de-DE', ' EN_gb ', 'de', 'zh-Hant-TW'],
    rejected: ['german', 'd', 'de-DE-x-y-z'],
  },
];

const label = (c: PatternCase) => `${c.tool.name}.${c.field}`;
const inputFor = (c: PatternCase, value: string) => ({
  ...c.required,
  [c.field]: c.array ? [value] : value,
});

describe('advertised identifier patterns', () => {
  it('scans license patterns with bounded thread CPU across 64-fold growth', () => {
    const pattern = advertisedPattern(searchWorksTool, 'licenses');
    const shapes = [
      (n: number) => '('.repeat(n),
      (n: number) => '[('.repeat(n / 2),
      (n: number) => `a${' a'.repeat(n / 2)}!`,
      (n: number) => `${'a'.repeat(n)}\n!`,
      (n: number) => `${'a\n'.repeat(n / 2)}!`,
      (n: number) => `a${' '.repeat(n)}!`,
    ];
    for (const shape of shapes) {
      const times: number[] = [];
      for (const size of [625, 1250, 2500, 5000, 10_000, 20_000, 40_000, 80_000]) {
        const value = shape(size);
        const results: boolean[] = [];
        const started = process.threadCpuUsage();
        for (let repeat = 0; repeat < 200; repeat++) results.push(pattern.test(value));
        const used = process.threadCpuUsage(started);
        const elapsed = used.user + used.system;
        expect(results).toEqual(Array<boolean>(200).fill(false));
        expect(elapsed).toBeLessThan(500_000);
        times.push(Math.max(1, elapsed));
      }
      // Keep the slope below Bun's large-input regex execution-mode boundary.
      expect(times[6]! / times[0]!).toBeLessThan(256);
    }
    // Thread CPU above bounds the work; allow wall time for descheduling in the full suite.
  }, 20_000);
  it('cover every patterned input across the tool surface', () => {
    const patterned = TOOLS.flatMap((tool) =>
      Object.entries(properties(tool))
        .filter(([, property]) => (property.pattern ?? property.items?.pattern) !== undefined)
        .map(([field]) => `${tool.name}.${field}`),
    );
    expect(patterned.sort()).toEqual(CASES.map(label).sort());
  });

  it.each(CASES.flatMap((c) => c.accepted.map((value) => [label(c), value, c] as const)))(
    '%s admits %j both in the advertised pattern and at the schema',
    (_name, value, c) => {
      expect(c.tool.input.safeParse(inputFor(c, value)).success).toBe(true);
      expect(advertisedPattern(c.tool, c.field).test(value)).toBe(true);
    },
  );

  it.each(CASES.flatMap((c) => c.rejected.map((value) => [label(c), value, c] as const)))(
    '%s rejects %j both in the advertised pattern and at the schema',
    (_name, value, c) => {
      expect(c.tool.input.safeParse(inputFor(c, value)).success).toBe(false);
      expect(advertisedPattern(c.tool, c.field).test(value)).toBe(false);
    },
  );
});
