/**
 * @fileoverview `datacite_list_reference` — offline decoder for the controlled
 * vocabularies, identifier forms, and coverage rules the other tools use.
 * @module mcp-server/tools/definitions/list-reference
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getReferenceTopic, REFERENCE_TOPICS } from '@/services/reference/topics.js';
import { flattenInline, tableCell } from './_text.js';

export const listReferenceTool = tool('datacite_list_reference', {
  title: 'DataCite reference vocabularies',
  description:
    'Look up the controlled vocabularies and identifier forms the other datacite_* tools accept: resource types, relation types with their inverses and groups, related-identifier types, date and contributor types, fields of science, common license ids, repository types, certificates, software platforms, client types, sort orders, query-syntax field paths, citation formats, verified citation styles and locales, accepted identifier forms (DOI, ORCID iD, ROR ID, Crossref Funder ID, country, language, repository, and provider ids), and coverage and rate-limit rules. Offline; makes no upstream request.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    topic: z
      .enum(REFERENCE_TOPICS)
      .describe(
        'Which vocabulary or rule set to return. identifier_types lists related-identifier types (the relatedIdentifierType values datacite_trace_relations reports as node idType); identifier_formats lists the accepted input forms of DOIs, ORCID iDs, ROR IDs, Crossref Funder IDs, country and language codes, and repository and provider ids; query_syntax lists the field paths and operators of the datacite_search_works query input; coverage states what DataCite holds, the paging and facet limits, citation accrual, Event Data scope, and rate limits.',
      ),
  }),
  output: z.object({
    topic: z.enum(REFERENCE_TOPICS).describe('The topic returned.'),
    title: z.string().describe('Human-readable topic title.'),
    entries: z
      .array(
        z
          .object({
            value: z
              .string()
              .describe(
                'The value as the tools accept or return it; in identifier_formats the identifier kind (DOI, ORCID iD, …), in coverage a rule key.',
              ),
            label: z
              .string()
              .optional()
              .describe(
                'A label for the value: a display name in most topics, an example of the accepted form in identifier_formats, the upstream sort= parameter in sort_orders. Absent when the value needs none.',
              ),
            description: z.string().optional().describe('What the value means or how it is used.'),
            group: z
              .string()
              .optional()
              .describe(
                'Grouping: the relation-type family in relation_types, the FOS area in fields_of_science, verified or falls back to APA in citation_styles.',
              ),
            inverse: z.string().optional().describe('Inverse relation type, for relation_types.'),
          })
          .describe('One vocabulary entry.'),
      )
      .describe('The vocabulary entries.'),
    notes: z.array(z.string()).describe('Usage rules and caveats for the topic.'),
  }),

  handler(input) {
    return { topic: input.topic, ...getReferenceTopic(input.topic) };
  },

  format: (result) => {
    const lines = [
      `## ${result.title}`,
      '',
      `**Topic:** ${result.topic} · ${result.entries.length} entries`,
      '',
    ];
    lines.push('| Value | Label | Group | Inverse | Description |', '|:--|:--|:--|:--|:--|');
    for (const entry of result.entries) {
      lines.push(
        `| ${tableCell(entry.value)} | ${tableCell(entry.label ?? '')} | ${tableCell(entry.group ?? '')} | ${tableCell(entry.inverse ?? '')} | ${tableCell(entry.description ?? '')} |`,
      );
    }
    if (result.notes.length > 0) {
      lines.push('', '**Notes**');
      for (const note of result.notes) lines.push(`- ${flattenInline(note)}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
