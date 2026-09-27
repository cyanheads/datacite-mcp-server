/**
 * @fileoverview Tests for `datacite_list_reference` through its public contract
 * (`runToolContract`): every topic on both consumption paths with the counts the
 * design fixes, relation-type inverse symmetry, the schema rejection of an
 * unknown topic, and that the tool never reaches the network.
 * @module tests/mcp-server/tools/definitions/list-reference.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flattenInline, tableCell } from '@/mcp-server/tools/definitions/_text.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { REFERENCE_TOPICS, type ReferenceTopic } from '@/services/reference/topics.js';
import {
  contentText,
  structured,
  type ToolResultLike,
  toolError,
} from '../../../helpers/harness.js';

type Output = z.infer<typeof listReferenceTool.output>;

afterEach(() => {
  vi.restoreAllMocks();
});

const run = (topic: ReferenceTopic) => runToolContract(listReferenceTool, { topic });
const output = (result: ToolResultLike) => structured<Output>(result);

/** Entry counts the design fixes for the enumerated vocabularies. */
const COUNTS: Partial<Record<ReferenceTopic, number>> = {
  resource_types: 34,
  relation_types: 39,
  fields_of_science: 48,
  citation_locales: 61,
  sort_orders: 7,
  identifier_formats: 8,
};

describe('datacite_list_reference', () => {
  it('offers the 18 topics', () => {
    expect(REFERENCE_TOPICS).toHaveLength(18);
  });

  it.each(REFERENCE_TOPICS)('returns %s on both surfaces without any request', async (topic) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await run(topic);
    expect(result.isError).toBeFalsy();
    const out = output(result);
    expect(out.topic).toBe(topic);
    expect(out.entries.length).toBeGreaterThan(0);
    expect(out.notes.length).toBeGreaterThan(0);
    const expected = COUNTS[topic];
    if (expected !== undefined) expect(out.entries).toHaveLength(expected);
    expect(new Set(out.entries.map((entry) => entry.value)).size).toBe(out.entries.length);

    const text = contentText(result);
    expect(text).toContain(
      `## ${out.title}\n\n**Topic:** ${topic} · ${out.entries.length} entries`,
    );
    for (const entry of out.entries) {
      const cells = [entry.value, entry.label, entry.group, entry.inverse, entry.description];
      expect(text).toContain(`| ${cells.map((cell) => tableCell(cell ?? '')).join(' | ')} |`);
    }
    for (const note of out.notes) expect(text).toContain(`- ${flattenInline(note)}`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('pairs every relation type with an inverse that points back within its group', async () => {
    const { entries } = output(await run('relation_types'));
    const byValue = new Map(entries.map((entry) => [entry.value, entry]));
    for (const entry of entries) {
      if (entry.inverse === undefined) continue;
      const inverse = byValue.get(entry.inverse);
      expect(inverse, `${entry.value} → ${entry.inverse}`).toBeDefined();
      expect(inverse?.inverse).toBe(entry.value);
      expect(inverse?.group).toBe(entry.group);
    }
    expect(entries.filter((entry) => entry.inverse === undefined).map((e) => e.value)).toEqual([
      'IsPublishedIn',
      'Other',
    ]);
    expect(byValue.get('IsIdenticalTo')?.inverse).toBe('IsIdenticalTo');
    expect(
      entries.filter((entry) => entry.group === 'citations').map((entry) => entry.value),
    ).toEqual([
      'Cites',
      'IsCitedBy',
      'References',
      'IsReferencedBy',
      'IsSupplementTo',
      'IsSupplementedBy',
    ]);
  });

  it('lists each sort order with the upstream sort parameter it sends', async () => {
    const { entries } = output(await run('sort_orders'));
    expect(entries.map((entry) => [entry.value, entry.label])).toEqual([
      ['relevance', 'sort=relevance'],
      ['newest', 'sort=-created'],
      ['oldest', 'sort=created'],
      ['recently_updated', 'sort=-updated'],
      ['most_cited', 'sort=-citation-count'],
      ['most_viewed', 'sort=-view-count'],
      ['most_downloaded', 'sort=-download-count'],
    ]);
  });

  it('states identifier forms with a real example DOI and the any-case ids the inputs accept', async () => {
    const result = await run('identifier_formats');
    const byValue = new Map(output(result).entries.map((entry) => [entry.value, entry]));
    expect(byValue.get('DOI')?.label).toBe('10.5061/dryad.234');
    const text = contentText(result);
    for (const id of ['ROR ID', 'Repository ID', 'Provider ID']) {
      const entry = byValue.get(id);
      expect(entry?.description, id).toContain('any case');
      expect(entry?.description, id).not.toMatch(/lowercase/i);
    }
    for (const id of ['DOI', 'ROR ID', 'Repository ID', 'Provider ID']) {
      const entry = byValue.get(id);
      const cells = [entry?.value, entry?.label, entry?.group, entry?.inverse, entry?.description];
      expect(text).toContain(`| ${cells.map((cell) => tableCell(cell ?? '')).join(' | ')} |`);
    }
    expect(text).toContain('| DOI | 10.5061/dryad.234 |');
  });

  it('tells query writers to leave / bare, since DataCite escapes it and a pre-escaped \\/ fails', async () => {
    const result = await run('query_syntax');
    const reserved = output(result).notes.find((note) => note.startsWith('Reserved characters'));
    expect(reserved).toBeDefined();
    expect(reserved).not.toContain('\\ / must be escaped');
    expect(reserved).toContain('Leave / bare');
    expect(contentText(result)).toContain(`- ${flattenInline(reserved ?? '')}`);
  });

  it('leaves out the CSL locales DataCite renders as APA in US English, and says why', async () => {
    const result = await run('citation_locales');
    const { entries, notes } = output(result);
    const values = entries.map((entry) => entry.value);
    expect(values).not.toContain('tl-PH');
    expect(values).not.toContain('hy-AM');
    const selections = notes.find((note) => note.startsWith('A bare language code'));
    expect(selections).not.toMatch(/\b(tl|hy) →/);
    const excluded = notes.find((note) => note.includes('tl-PH'));
    expect(excluded).toBe(
      "CSL's tl-PH (Tagalog) and hy-AM (Armenian) are not listed and are rejected: DataCite renders the whole citation as APA in US English for them.",
    );
    expect(contentText(result)).toContain(`- ${flattenInline(excluded ?? '')}`);
  });

  it('groups the 48 fields of science under the 6 OECD areas', async () => {
    const { entries } = output(await run('fields_of_science'));
    expect(new Set(entries.map((entry) => entry.group)).size).toBe(6);
    expect(entries.find((entry) => entry.value === 'nanotechnology')).toMatchObject({
      label: 'Nanotechnology',
      description: expect.stringContaining('"Nano-technology"'),
    });
  });

  it.each(['glossary', '', 'Resource Types'])(
    'rejects the unknown topic %j at the schema',
    async (topic) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const result = await runToolContract(listReferenceTool, {
        topic: topic as ReferenceTopic,
      });
      const error = toolError(result);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_arguments');
      expect(error.message).toContain('topic');
      expect(contentText(result)).toContain('(reason invalid_arguments)');
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});
