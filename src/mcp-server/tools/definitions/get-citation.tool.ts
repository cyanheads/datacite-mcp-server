/**
 * @fileoverview `datacite_get_citation` — one DataCite DOI as a CSL-formatted
 * citation (style + locale) or a machine format. A style the upstream would
 * silently render as APA is rejected instead.
 * @module mcp-server/tools/definitions/get-citation
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { renderCitation } from '@/services/datacite/citation.js';
import { getDataCiteService } from '@/services/datacite/datacite-service.js';
import { htmlToText } from '@/services/datacite/html-text.js';
import { normalizeDoi } from '@/services/datacite/normalize.js';
import { getRegistrationAgencyService } from '@/services/doi-ra/doi-ra-service.js';
import {
  CITATION_FORMAT_IDS,
  CITATION_FORMATS,
  type CitationFormat,
  resolveCslLocale,
} from '@/services/reference/citation.js';
import { buildResolver } from '@/services/reference/lookup.js';
import { missFields, missGuidance } from './_miss.js';
import { blankAsUnset, doiString, enumish, optionalString } from './_schemas.js';
import { blockquote, fenced, flattenInline } from './_text.js';

const resolveFormat = buildResolver(
  CITATION_FORMAT_IDS.map((id) => ({
    id,
    aliases: id === 'schema_org' ? ['schema.org', 'schemaorg_jsonld'] : [],
  })),
);

/** Fence language for each machine format. */
const FENCE_LANGUAGE: Record<CitationFormat, string> = {
  text: '',
  csl_json: 'json',
  bibtex: 'bibtex',
  ris: '',
  datacite_json: 'json',
  datacite_xml: 'xml',
  schema_org: 'json',
  codemeta: 'json',
  jats: 'xml',
};

export const getCitationTool = tool('datacite_get_citation', {
  title: 'Get DataCite citation',
  description:
    'Render one DataCite DOI as a formatted citation in a CSL style and locale (APA in US English by default), or as a machine-readable record: CSL JSON, BibTeX, RIS, DataCite JSON or XML, Schema.org JSON-LD, Codemeta, or JATS. A style the upstream renderer does not support — an unknown id or a dependent journal style — is rejected instead of silently rendered as APA. Formatted text comes back as plain text alongside the upstream HTML markup. A DOI DataCite does not hold returns found: false naming the registration agency that does.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_doi',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The doi input is not a DOI after normalization.',
      severity: 'notice',
      recovery: 'Pass a DOI such as 10.5061/dryad.234; find one with datacite_search_works.',
    },
    {
      reason: 'unsupported_style',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The style check finds the upstream rendering the default APA output instead of the requested non-APA style (unknown id, dependent journal style, retired id).',
      severity: 'notice',
      recovery:
        'Use a current independent CSL style id from datacite_list_reference topic citation_styles, or omit style for APA; a journal-specific style needs its independent parent style id.',
    },
    {
      reason: 'unsupported_locale',
      code: JsonRpcErrorCode.ValidationError,
      when: 'locale is not a CSL locale.',
      severity: 'notice',
      recovery:
        'Pass a CSL locale such as en-GB, de-DE, or fr-FR from datacite_list_reference topic citation_locales, or omit locale for US English.',
    },
    {
      reason: 'style_requires_text',
      code: JsonRpcErrorCode.ValidationError,
      when: 'style or locale set with a machine format.',
      severity: 'notice',
      recovery:
        'Drop style and locale, or set format to text; they apply only to formatted citations.',
    },
    {
      reason: 'format_unavailable',
      code: JsonRpcErrorCode.NotFound,
      when: 'DataCite answers 204: no metadata is available in that format for this DOI.',
      severity: 'info',
      recovery:
        'Request another format such as datacite_json or csl_json, or call datacite_get_work for the full record.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "This deployment's shared DataCite request budget is spent: its request queue could not start a request before the call's deadline, or DataCite answered HTTP 429.",
      retryable: true,
      thrownBy: 'service',
      recovery:
        "Wait the number of seconds this error states, then retry; this deployment's shared DataCite request budget is spent for the current 5-minute window.",
    },
  ],

  input: z.object({
    doi: doiString().describe(
      'The DataCite DOI, e.g. 10.5061/dryad.234. Bare, doi:, or a doi.org URL; case-insensitive.',
    ),
    format: blankAsUnset(enumish(CITATION_FORMAT_IDS, resolveFormat).default('text')).describe(
      'text (formatted citation, default), csl_json, bibtex, ris, datacite_json, datacite_xml, schema_org, codemeta, or jats.',
    ),
    style: optionalString(
      z
        .string()
        .regex(
          /^\s*[A-Za-z0-9-]+\s*$/,
          'Expected a CSL style id of letters, digits, and hyphens, such as apa, ieee, or chicago-author-date; verified ids: datacite_list_reference topic citation_styles.',
        ),
    ).describe(
      'CSL style id for format text, e.g. apa (default), ieee, chicago-author-date, modern-language-association, vancouver, nature. Lowercased. A style that would silently fall back to APA is rejected. Verified ids: datacite_list_reference topic citation_styles.',
    ),
    locale: optionalString(
      z
        .string()
        .regex(
          /^\s*[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,4}){0,2}\s*$/,
          'Expected a CSL locale such as en-GB or de-DE, or a bare language code such as de; list: datacite_list_reference topic citation_locales.',
        ),
    ).describe(
      'CSL locale for format text, e.g. en-GB, de-DE, fr-FR, or a bare language (de → de-DE); any case. Omitted: en-US. List: datacite_list_reference topic citation_locales.',
    ),
  }),

  output: z.object({
    found: z
      .boolean()
      .describe(
        'True when DataCite holds the DOI and rendered it; false when it holds no public record (the miss fields explain).',
      ),
    doi: z.string().describe('The DOI, lowercase.'),
    format: z.enum(CITATION_FORMAT_IDS).describe('The format requested.'),
    mediaType: z.string().optional().describe('Media type negotiated. Found only.'),
    style: z.string().optional().describe('CSL style applied (text only).'),
    locale: z.string().optional().describe('CSL locale applied (text only; absent means en-US).'),
    citation: z
      .string()
      .optional()
      .describe(
        'text: the citation as plain text (tags stripped, entities decoded); machine formats: the payload verbatim.',
      ),
    citationHtml: z
      .string()
      .optional()
      .describe('text only: the upstream HTML markup verbatim (<i>, &amp;, small caps).'),
    ...missFields,
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Set when the style could not be confirmed as distinct from APA.'),
  },

  async handler(input, ctx) {
    const doi = normalizeDoi(input.doi);
    if (!doi) {
      throw ctx.fail(
        'invalid_doi',
        'The doi input is not a DOI after normalization; expected 10.<registrant>/<suffix>, bare or as a doi.org URL.',
        ctx.recoveryFor('invalid_doi'),
      );
    }
    if (input.format !== 'text' && (input.style || input.locale)) {
      throw ctx.fail(
        'style_requires_text',
        `style and locale apply only to format text, not ${input.format}.`,
        ctx.recoveryFor('style_requires_text'),
      );
    }
    const locale = input.locale ? resolveCslLocale(input.locale) : undefined;
    if (input.locale && !locale) {
      throw ctx.fail(
        'unsupported_locale',
        'locale is not a CSL locale; the upstream would silently render an unknown locale as APA in US English.',
        ctx.recoveryFor('unsupported_locale'),
      );
    }
    const style = input.style?.toLowerCase();

    const outcome = await renderCitation(
      getDataCiteService(),
      { doi, format: input.format, ...(style && { style }), ...(locale && { locale }) },
      ctx,
    );
    if (outcome.kind === 'unsupported_style') {
      throw ctx.fail(
        'unsupported_style',
        'DataCite renders the requested style as the default APA citation, so that style id is not supported upstream (unknown, retired, wrong-case, or a dependent journal style).',
        ctx.recoveryFor('unsupported_style'),
      );
    }
    if (outcome.kind === 'no_content') {
      throw ctx.fail(
        'format_unavailable',
        `DataCite has no metadata available in ${input.format} for this DOI (HTTP 204).`,
        ctx.recoveryFor('format_unavailable'),
      );
    }
    if (outcome.kind === 'not_found') {
      const miss = await getRegistrationAgencyService().classifyMiss(doi, ctx);
      return {
        found: false,
        doi,
        format: input.format,
        ...miss,
        guidance: missGuidance(doi, miss, 'citation'),
      };
    }

    if (outcome.notice) ctx.enrich.notice(outcome.notice);
    const isText = input.format === 'text';
    return {
      found: true,
      doi,
      format: input.format,
      mediaType: CITATION_FORMATS[input.format],
      ...(isText && { style: style ?? 'apa' }),
      ...(isText && locale && { locale }),
      citation: isText ? htmlToText(outcome.body) : outcome.body,
      ...(isText && { citationHtml: outcome.body.trim() }),
    };
  },

  format: (result) => {
    const lines = [
      result.found ? `**Citation** — ${result.doi}` : `**Not found in DataCite** — ${result.doi}`,
      `**Found:** ${result.found} · **Format:** ${result.format}${result.mediaType ? ` (${result.mediaType})` : ''}${result.style ? ` · **Style:** ${flattenInline(result.style)}` : ''}${result.locale ? ` · **Locale:** ${result.locale}` : ''}`,
    ];
    if (result.missReason) lines.push(`**Miss reason:** ${result.missReason}`);
    if (result.registrationAgency)
      lines.push(`**Registration agency:** ${flattenInline(result.registrationAgency)}`);
    if (result.guidance) lines.push('', flattenInline(result.guidance));
    if (result.citation !== undefined) {
      lines.push(
        '',
        result.format === 'text'
          ? blockquote(result.citation)
          : fenced(result.citation, FENCE_LANGUAGE[result.format]),
      );
    }
    if (result.citationHtml !== undefined) lines.push('', fenced(result.citationHtml, 'html'));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
