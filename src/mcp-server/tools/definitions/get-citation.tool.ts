/**
 * @fileoverview `datacite_get_citation` — one DataCite DOI as a CSL-formatted
 * citation (style + locale) or a machine format, returned whole or one slice at
 * a time. A style the upstream would silently render as APA is rejected instead.
 * @module mcp-server/tools/definitions/get-citation
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { type DocumentSlice, renderCitation, sliceDocument } from '@/services/datacite/citation.js';
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
import { applyCount, countInput } from './_counts.js';
import { missFields, missGuidance } from './_miss.js';
import { blankAsUnset, doiString, enumish, MAX_CHARS, optionalString } from './_schemas.js';
import { blockquote, fenced, flattenInline, num } from './_text.js';

/**
 * The most UTF-16 units one slice holds. A record with thousands of related
 * identifiers renders to megabytes; a slice this long of the heaviest real
 * exports is about 1 MB on each response surface.
 */
const MAX_SLICE_UNITS = 1_000_000;
/** Units per slice when the caller sets no limit. */
const DEFAULT_SLICE_UNITS = 100_000;

/** Where a caller gets the rest of a sliced document without paging it. */
const REFERRALS =
  'downloadUrl returns the whole document in one response, and datacite_get_work returns the record with each long list capped and its full count reported.';

/**
 * The notice on a slice short of the whole document: the units it holds, and
 * `nextCall` (the call that reads on) while units remain past it.
 */
function sliceNotice(
  format: CitationFormat,
  total: number,
  offset: number,
  { start, end }: DocumentSlice,
  nextCall: object,
): string {
  if (offset >= total) {
    return `offset ${num(offset)} is at or past the end of this ${format} document, which runs to ${num(total)} UTF-16 units, so the slice is empty. Pass offset 0 to start from the beginning.`;
  }
  const span = `This ${format} document runs to ${num(total)} UTF-16 units; ${format === 'text' ? 'citationHtml' : 'citation'} holds`;
  return end === total
    ? `${span} the last ${num(end - start)} of them, from offset ${num(start)}. downloadUrl returns the whole document in one response.`
    : `${span} ${num(end - start)} of them from offset ${num(start)}. Continue with datacite_get_citation ${JSON.stringify(nextCall)}. ${REFERRALS}`;
}

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

/** How DataCite said it cannot render a DOI in a format, by the status it answered. */
const NO_RENDERING = {
  200: 'HTTP 200 with an empty body',
  204: 'HTTP 204, no metadata available',
  400: 'HTTP 400 from its renderer',
} as const;

export const getCitationTool = tool('datacite_get_citation', {
  title: 'Get DataCite citation',
  description:
    'Render one DataCite DOI as a formatted citation in a CSL style and locale (APA in US English by default), or as a machine-readable record: CSL JSON, BibTeX, RIS, DataCite JSON or XML, Schema.org JSON-LD, Codemeta, or JATS. A style the upstream renderer does not support — an unknown id or a dependent journal style — is rejected instead of silently rendered as APA. Formatted text comes back as plain text alongside the upstream HTML markup. A long document comes back one slice at a time: limit sets the slice size in UTF-16 units (default 100,000) and nextOffset continues it. A DOI DataCite does not hold returns found: false naming the registration agency that does.',
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
      when: 'locale is not a CSL locale DataCite renders (CSL locales tl-PH and hy-AM render as APA in US English).',
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
      when: 'DataCite cannot render this DOI in the requested format: it answers HTTP 204, HTTP 200 with an empty body, or HTTP 400.',
      severity: 'info',
      recovery:
        'Request another format such as datacite_json or csl_json, or call datacite_get_work for the full record.',
    },
    {
      reason: 'render_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCite answered HTTP 5xx on every attempt; a renderer fault on this record and a brief outage give the same status.',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Request another format such as datacite_json or csl_json, or call datacite_get_work for the full record; retry this format later, since DataCite also answers a brief outage with HTTP 5xx.',
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
      'The DataCite DOI, e.g. 10.5061/dryad.234. Accepted bare, with doi: or info:doi/ prefixes, as a doi.org / dx.doi.org URL, or %2F-encoded; case-insensitive.',
    ),
    format: blankAsUnset(enumish(CITATION_FORMAT_IDS, resolveFormat).default('text')).describe(
      'text (formatted citation, default), csl_json, bibtex, ris, datacite_json, datacite_xml, schema_org, codemeta, or jats.',
    ),
    style: optionalString(
      z
        .string()
        .max(MAX_CHARS.style)
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
    offset: blankAsUnset(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()).describe(
      "Zero-based offset, in UTF-16 code units, where the slice starts (for text, into the upstream HTML); default 0. An offset inside a surrogate pair, or for text inside a tag or character reference, starts the slice at that unit's start. Pass nextOffset to continue. At or past the end the slice is empty.",
    ),
    limit: countInput(MAX_SLICE_UNITS, DEFAULT_SLICE_UNITS).describe(
      'UTF-16 code units of the document per slice (for text, of the upstream HTML), a positive integer (default 100,000). A slice ends early rather than split a surrogate pair, or for text a tag or character reference, and runs past limit only when one such unit alone is longer. Values above 1,000,000 apply 1,000,000 with a notice unless strict limits are configured.',
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
        'text: the citation as plain text (tags stripped, entities decoded) of the HTML in citationHtml; each slice is converted on its own, so join citationHtml slices, not these, to rebuild a paged text document. Machine formats: the document verbatim, or the slice of it offset and limit select, never splitting a surrogate pair; slices joined in offset order reproduce it exactly. Empty when offset is at or past the end.',
      ),
    downloadUrl: z
      .string()
      .optional()
      .describe(
        'Exact negotiated URL for the whole document, returned with a slice short of it; fetch it to retrieve the document in one response.',
      ),
    totalCharacters: z
      .number()
      .optional()
      .describe(
        'Length of the whole document in UTF-16 code units (for text, of the upstream HTML), returned with a slice short of it.',
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Where the next slice starts: call again with the same doi, format, style, locale, and limit, and this as offset. Absent once a slice reaches the end.',
      ),
    citationHtml: z
      .string()
      .optional()
      .describe(
        'text only: the upstream HTML markup verbatim (<i>, &amp;, small caps): the whole rendering trimmed, or the exact slice offset and limit select, which never ends inside a tag or character reference.',
      ),
    ...missFields,
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when citation is a slice short of the whole document: units remain past it (nextOffset), or offset starts it past the beginning.',
      ),
    shown: z
      .number()
      .optional()
      .describe('UTF-16 code units in this slice (for text, of the HTML in citationHtml).'),
    cap: z.number().optional().describe('The limit applied, in UTF-16 code units.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Set when the style could not be confirmed as distinct from APA, JATS contains empty names or inconsistent years, a limit over 1,000,000 was applied as 1,000,000, or citation is a slice of the document (its range and the call that continues it).',
      ),
  },

  enrichmentTrailer: {
    notice: { render: (notice) => (notice === undefined ? '' : blockquote(notice)) },
  },

  async handler(input, ctx) {
    const doi = normalizeDoi(input.doi);
    if (!doi) {
      throw ctx.fail(
        'invalid_doi',
        'The doi input is not a DOI after normalization; expected 10.<registrant>/<suffix>, bare or as a doi.org URL.',
      );
    }
    if (input.format !== 'text' && (input.style || input.locale)) {
      throw ctx.fail(
        'style_requires_text',
        `style and locale apply only to format text, not ${input.format}.`,
      );
    }
    const locale = input.locale ? resolveCslLocale(input.locale) : undefined;
    if (input.locale && !locale) {
      throw ctx.fail(
        'unsupported_locale',
        'locale is not a CSL locale DataCite renders; DataCite would silently render the whole citation as APA in US English.',
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
      );
    }
    if (outcome.kind === 'no_content') {
      throw ctx.fail(
        'format_unavailable',
        `DataCite cannot render this DOI in ${input.format} (${NO_RENDERING[outcome.status]}).`,
      );
    }
    if (outcome.kind === 'not_found') {
      const miss = await getRegistrationAgencyService().classifyMiss(doi, ctx);
      return {
        found: false,
        doi,
        format: input.format,
        ...miss,
        guidance: missGuidance(doi, miss, input.format),
      };
    }

    const notices: string[] = outcome.notice ? [outcome.notice] : [];
    const limit = applyCount(
      input.limit,
      MAX_SLICE_UNITS,
      'limit',
      'datacite_get_citation',
      ctx,
      notices,
    );
    const isText = input.format === 'text';
    const { body } = outcome;
    const offset = input.offset ?? 0;
    const { start, end } = sliceDocument(body, offset, limit, isText);
    const slice = body.slice(start, end);
    const whole = start === 0 && end === body.length;
    const nextOffset = end < body.length ? end : undefined;
    if (whole) {
      if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    } else {
      const nextCall = {
        doi,
        format: input.format,
        ...(style && { style }),
        ...(locale && { locale }),
        limit,
        offset: end,
      };
      notices.push(sliceNotice(input.format, body.length, offset, { start, end }, nextCall));
      ctx.enrich.truncated({ shown: end - start, cap: limit, guidance: notices.join(' ') });
    }
    return {
      found: true,
      doi,
      format: input.format,
      mediaType: CITATION_FORMATS[input.format],
      ...(isText && { style: style ?? 'apa' }),
      ...(isText && locale && { locale }),
      citation: isText ? htmlToText(slice) : slice,
      ...(isText && { citationHtml: whole ? slice.trim() : slice }),
      ...(!whole && { downloadUrl: outcome.downloadUrl, totalCharacters: body.length }),
      ...(nextOffset !== undefined && { nextOffset }),
    };
  },

  format: (result) => {
    const lines = [
      result.found
        ? `**Citation** — ${flattenInline(result.doi)}`
        : `**Not found in DataCite** — ${flattenInline(result.doi)}`,
      `**Found:** ${result.found} · **Format:** ${result.format}${result.mediaType ? ` (${result.mediaType})` : ''}${result.style ? ` · **Style:** ${flattenInline(result.style)}` : ''}${result.locale ? ` · **Locale:** ${result.locale}` : ''}`,
    ];
    if (result.missReason) lines.push(`**Miss reason:** ${result.missReason}`);
    if (result.registrationAgency)
      lines.push(`**Registration agency:** ${flattenInline(result.registrationAgency)}`);
    if (result.guidance) lines.push('', flattenInline(result.guidance));
    if (result.downloadUrl)
      lines.push('', markdownLink('Download complete document', result.downloadUrl));
    if (result.totalCharacters !== undefined)
      lines.push(`**Total characters:** ${num(result.totalCharacters)} (UTF-16 code units)`);
    if (result.nextOffset !== undefined) lines.push(`**Next offset:** ${result.nextOffset}`);
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
