/**
 * @fileoverview Tests for `datacite_get_citation` through its public contract
 * (`runToolContract` over a fake `fetch`): the default APA path, the style
 * verdict (default comparison, canary pair, verdict cache, APA variants, a
 * canary that fails), locales, machine formats and their fences, the miss arm,
 * and every declared error reason — each on both `structuredContent` and
 * `content[]`.
 * @module tests/mcp-server/tools/definitions/get-citation.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCitationTool } from '@/mcp-server/tools/definitions/get-citation.tool.js';
import { getDataCiteService } from '@/services/datacite/datacite-service.js';
import { CITATION_FORMATS } from '@/services/reference/citation.js';
import { fixtureResponse, fixtureText, rateLimitResponse } from '../../../helpers/fixtures.js';
import {
  contentText,
  dataCite,
  declaredSeverities,
  doiRa,
  initServices,
  json,
  requestUrl,
  requestUrls,
  structured,
  type ToolResultLike,
  teardownServices,
  text,
  toolError,
} from '../../../helpers/harness.js';

type Input = z.input<typeof getCitationTool.input>;
type Output = z.infer<typeof getCitationTool.output> & {
  cap?: number;
  notice?: string;
  shown?: number;
  truncated?: boolean;
};

const DOI = '10.5061/dryad.8515';
/** `DOI` as the negotiation path carries it, encoded whole. */
const DOI_PATH = '10.5061%2Fdryad.8515';
const CANARY = '10.5061/dryad.234';
const TERSE = '10.5555/terse';

const DEFAULT_HTML = fixtureText('datacite/citations/dryad-8515-default.html');
const IEEE_HTML = fixtureText('datacite/citations/dryad-8515-ieee.html');
const CANARY_DEFAULT_HTML = fixtureText('datacite/citations/canary-dryad-234-default.html');
/** Constructed — a record short enough to render identically in the default and a requested style. */
const TERSE_HTML = 'Terse. (2020). <i>Terse record</i>. https://doi.org/10.5555/TERSE';

afterEach(() => {
  vi.useRealTimers();
  teardownServices();
});

const run = (input: Input) => runToolContract(getCitationTool, input);
const output = (result: ToolResultLike) => structured<Output>(result);

/** The content-negotiation path for `doi` in `mime`, the DOI encoded whole. */
const negotiationPath = (doi: string, mime = 'text/x-bibliography') =>
  `/dois/${mime}/${encodeURIComponent(doi)}`;

/** A negotiation route whose parameters are exactly `query`, in any order (`{}` = none). */
const negotiation = (doi: string, query: Record<string, string> = {}, mime?: string) =>
  dataCite(negotiationPath(doi, mime), (url) => {
    const sent = JSON.stringify([...url.searchParams].sort());
    return sent === JSON.stringify(Object.entries(query).sort());
  });

const html = (body: string) => text(body, { headers: { 'content-type': 'text/html' } });

const expectToolError = (result: ToolResultLike, reason: string, code: number) => {
  const error = toolError(result);
  expect(error.code).toBe(code);
  expect(error.data?.reason).toBe(reason);
  expect(contentText(result)).toContain(`(reason ${reason}`);
  return error;
};

const DEFAULT_TEXT =
  'Ollomo, B., Durand, P., Prugnolle, F., Douzery, E. J. P., Arnathau, C., Nkoghe, D., Leroy, E., & Renaud, F. (2011). Data from: A new malaria agent in African hominids. (Version 1) [Dataset]. Dryad. https://doi.org/10.5061/DRYAD.8515';

/** The notice a cached `apa_variant_unconfirmed` verdict carries — no rendering was compared on that call. */
const CACHED_APA_VARIANT_NOTICE =
  'An earlier check found apa-single-spaced rendering the same text as the default APA style, and APA variants that differ only in layout cannot be told apart from APA, so it could not be confirmed that apa-single-spaced was applied; treat this as APA text if the two styles should differ.';

/**
 * The answers DataCite gives for a format it cannot render for a record, with
 * the detail `format_unavailable` names. The 204 is documented but was never
 * observed; the empty 200 and the 400 (body recorded) were.
 */
const UNRENDERABLE = [
  {
    name: 'HTTP 204',
    respond: () => new Response(null, { status: 204 }),
    detail: 'HTTP 204, no metadata available',
  },
  { name: 'an empty HTTP 200', respond: () => text(''), detail: 'HTTP 200 with an empty body' },
  {
    name: 'HTTP 400',
    respond: () =>
      fixtureResponse('datacite/errors/negotiation-400-unrenderable.json', { status: 400 }),
    detail: 'HTTP 400 from its renderer',
  },
];

const FORMAT_UNAVAILABLE_RECOVERY =
  'Recovery: Request another format such as datacite_json or csl_json, or call datacite_get_work for the full record.';

describe('formatted citations', () => {
  it('renders APA by default in one request, as plain text and verbatim HTML on both surfaces', async () => {
    const { http } = initServices([{ match: negotiation(DOI), respond: html(DEFAULT_HTML) }]);
    const result = await run({ doi: DOI });
    expect(result.isError).toBeFalsy();
    expect(output(result)).toEqual({
      found: true,
      doi: DOI,
      format: 'text',
      mediaType: 'text/x-bibliography',
      style: 'apa',
      citation: DEFAULT_TEXT,
      citationHtml: DEFAULT_HTML.trim(),
    });
    const content = contentText(result);
    expect(content).toContain(`**Citation** — ${DOI}`);
    expect(content).toContain(
      '**Found:** true · **Format:** text (text/x-bibliography) · **Style:** apa',
    );
    expect(content).not.toContain('**Locale:**');
    expect(content).toContain(`> ${DEFAULT_TEXT}`);
    expect(content).toContain(`\`\`\`html\n${DEFAULT_HTML.trim()}\n\`\`\``);
    expect(http.calls).toHaveLength(1);
    expect(requestUrl(http).href).toBe(
      'https://api.datacite.org/dois/text/x-bibliography/10.5061%2Fdryad.8515',
    );
  });

  it('sends an explicit apa as a parameter without a style check', async () => {
    const { http } = initServices([
      { match: negotiation(DOI, { style: 'apa' }), respond: html(DEFAULT_HTML) },
    ]);
    const out = output(await run({ doi: DOI, style: 'APA' }));
    expect(out).toMatchObject({ found: true, style: 'apa', citation: DEFAULT_TEXT });
    expect(http.calls).toHaveLength(1);
  });

  it('treats a blank style and locale as unset', async () => {
    const { http } = initServices([{ match: negotiation(DOI), respond: html(DEFAULT_HTML) }]);
    const out = output(await run({ doi: DOI, style: ' ', locale: '' }));
    expect(out).toMatchObject({ found: true, style: 'apa' });
    expect(out).not.toHaveProperty('locale');
    expect(http.calls).toHaveLength(1);
  });

  it('fences HTML with a fence longer than any backtick run in it', async () => {
    const body = 'A ```` B. (2020). <i>Tick</i>.';
    initServices([{ match: negotiation(TERSE), respond: html(body) }]);
    const content = contentText(await run({ doi: TERSE }));
    expect(content).toContain(`\`\`\`\`\`html\n${body}\n\`\`\`\`\``);
  });

  it('keeps a stray < in the plain text on both surfaces', async () => {
    const body = 'Terse. (2020). <i>Below T < 5 K</i> [Dataset]. Dryad.';
    const plain = 'Terse. (2020). Below T < 5 K [Dataset]. Dryad.';
    initServices([{ match: negotiation(TERSE), respond: html(body) }]);
    const result = await run({ doi: TERSE });
    expect(output(result)).toMatchObject({ citation: plain, citationHtml: body });
    expect(contentText(result)).toContain(`> ${plain}`);
  });
});

describe('style verdicts', () => {
  it('lowercases IEEE, confirms it against the default in two requests, and reuses the verdict', async () => {
    const { http } = initServices([
      { match: negotiation(DOI, { style: 'ieee' }), respond: html(IEEE_HTML) },
      { match: negotiation(DOI), respond: html(DEFAULT_HTML) },
      {
        match: negotiation(CANARY, { style: 'ieee', locale: 'de-DE' }),
        respond: fixtureResponse('datacite/citations/canary-dryad-234-ieee-de-DE.html'),
      },
    ]);
    const first = output(await run({ doi: DOI, style: 'IEEE' }));
    expect(first).toMatchObject({ found: true, style: 'ieee', citationHtml: IEEE_HTML.trim() });
    expect(first).not.toHaveProperty('notice');
    expect(http.calls).toHaveLength(2);

    const second = await run({ doi: CANARY, style: 'ieee', locale: 'de' });
    expect(output(second)).toMatchObject({
      found: true,
      style: 'ieee',
      locale: 'de-DE',
      citation:
        'A. E. Zanne u. a., „Data from: Towards a worldwide wood economics spectrum“. Dryad, 4. Februar 2009. doi: 10.5061/DRYAD.234.',
    });
    expect(contentText(second)).toContain('· **Style:** ieee · **Locale:** de-DE');
    expect(http.calls).toHaveLength(3);
  });

  it('rejects mla through the canary pair, then from the cached verdict with no request', async () => {
    const { http } = initServices([
      { match: negotiation(DOI, { style: 'mla' }), respond: html(DEFAULT_HTML) },
      { match: negotiation(DOI), respond: html(DEFAULT_HTML) },
      { match: negotiation(CANARY, { style: 'mla' }), respond: html(CANARY_DEFAULT_HTML) },
      { match: negotiation(CANARY), respond: html(CANARY_DEFAULT_HTML) },
    ]);
    const result = await run({ doi: DOI, style: 'mla' });
    expectToolError(result, 'unsupported_style', JsonRpcErrorCode.ValidationError);
    expect(contentText(result)).toContain(
      'Recovery: Use a current independent CSL style id from datacite_list_reference topic citation_styles',
    );
    expect(http.calls).toHaveLength(4);
    expect(
      requestUrls(http).filter((url) => url.pathname === negotiationPath(CANARY)),
    ).toHaveLength(2);

    const again = await run({ doi: '10.5555/any', style: 'MLA' });
    expectToolError(again, 'unsupported_style', JsonRpcErrorCode.ValidationError);
    expect(http.calls).toHaveLength(4);
  });

  it('confirms a style whose record renders like the default when the canary differs', async () => {
    const style = 'modern-language-association';
    const { http } = initServices([
      { match: negotiation(TERSE, { style }), respond: html(TERSE_HTML) },
      { match: negotiation(TERSE), respond: html(TERSE_HTML) },
      {
        match: negotiation(CANARY, { style }),
        respond: fixtureResponse('datacite/citations/canary-dryad-234-mla.html'),
      },
      { match: negotiation(CANARY), respond: html(CANARY_DEFAULT_HTML) },
      {
        match: negotiation(DOI, { style }),
        respond: fixtureResponse('datacite/citations/dryad-8515-modern-language-association.html'),
      },
    ]);
    const out = output(await run({ doi: TERSE, style }));
    expect(out).toMatchObject({ found: true, style, citationHtml: TERSE_HTML });
    expect(out).not.toHaveProperty('notice');
    expect(http.calls).toHaveLength(4);

    const next = output(await run({ doi: DOI, style }));
    expect(next.citation).toBe(
      'Ollomo, Benjamin, et al. “Data from: A New Malaria Agent in African Hominids.” Version 1, Dryad, 1 Feb. 2011, https://doi.org/10.5061/DRYAD.8515.',
    );
    expect(http.calls).toHaveLength(5);
  });

  it('returns an unconfirmable APA variant with a notice, and keeps the notice with the cached verdict', async () => {
    const style = 'apa-single-spaced';
    const { http } = initServices([
      { match: negotiation(DOI, { style }), respond: html(DEFAULT_HTML) },
      { match: negotiation(DOI), respond: html(DEFAULT_HTML) },
      { match: negotiation(CANARY, { style }), respond: html(CANARY_DEFAULT_HTML) },
      { match: negotiation(CANARY), respond: html(CANARY_DEFAULT_HTML) },
      { match: negotiation(TERSE, { style }), respond: html(TERSE_HTML) },
    ]);
    const notice =
      'The apa-single-spaced rendering is identical to the default APA output and APA variants that differ only in layout cannot be told apart from APA, so it could not be confirmed that apa-single-spaced was applied; treat this as APA text if the two styles should differ.';
    const result = await run({ doi: DOI, style });
    expect(output(result)).toMatchObject({ found: true, style, citation: DEFAULT_TEXT, notice });
    expect(contentText(result)).toContain(`> ${notice}`);
    expect(http.calls).toHaveLength(4);

    const cached = await run({ doi: TERSE, style });
    expect(output(cached)).toMatchObject({ found: true, style, notice: CACHED_APA_VARIANT_NOTICE });
    expect(http.calls).toHaveLength(5);
  });

  it('claims no comparison it did not make when an APA variant is served from the cached verdict with a locale', async () => {
    const style = 'apa-single-spaced';
    /** Constructed — the German rendering a recognized APA variant returns under de-DE. */
    const germanHtml =
      'Ollomo, B., Durand, P. u. a. (2011). <i>Data from: A new malaria agent in African hominids</i> (Version 1) [Datensatz]. Dryad. https://doi.org/10.5061/DRYAD.8515';
    const { http } = initServices([
      { match: negotiation(DOI, { style }), respond: html(DEFAULT_HTML) },
      { match: negotiation(DOI), respond: html(DEFAULT_HTML) },
      { match: negotiation(CANARY, { style }), respond: html(CANARY_DEFAULT_HTML) },
      { match: negotiation(CANARY), respond: html(CANARY_DEFAULT_HTML) },
      { match: negotiation(DOI, { style, locale: 'de-DE' }), respond: html(germanHtml) },
    ]);
    await run({ doi: DOI, style });
    expect(getDataCiteService().styleVerdicts.get(style)).toBe('apa_variant_unconfirmed');

    const result = await run({ doi: DOI, style, locale: 'de' });
    expect(result.isError).toBeFalsy();
    expect(output(result)).toMatchObject({
      found: true,
      style,
      locale: 'de-DE',
      citationHtml: germanHtml,
      notice: CACHED_APA_VARIANT_NOTICE,
    });
    const content = contentText(result);
    expect(content).toContain(`> ${CACHED_APA_VARIANT_NOTICE}`);
    expect(content).not.toContain('is identical to the default APA output');
    expect(http.calls).toHaveLength(5);
  });

  it.each([
    {
      name: 'answers 404',
      respond: () => fixtureResponse('datacite/errors/negotiation-404.json', { status: 404 }),
    },
    { name: 'answers an empty 200', respond: () => text('') },
  ])(
    'returns the rendering with a notice and caches no verdict when the canary $name',
    async ({ respond }) => {
      const style = 'chicago-author-date';
      initServices([
        { match: negotiation(TERSE, { style }), respond: html(TERSE_HTML) },
        { match: negotiation(TERSE), respond: html(TERSE_HTML) },
        { match: negotiation(CANARY, { style }), respond },
        { match: negotiation(CANARY), respond: html(CANARY_DEFAULT_HTML) },
      ]);
      const result = await run({ doi: TERSE, style });
      const notice =
        'The chicago-author-date rendering is identical to the default APA output and the style check could not complete, so it could not be confirmed that chicago-author-date was applied; treat this as APA text if the two styles should differ.';
      expect(result.isError).toBeFalsy();
      expect(output(result)).toMatchObject({
        found: true,
        style,
        citationHtml: TERSE_HTML,
        notice,
      });
      expect(contentText(result)).toContain(`> ${notice}`);
      expect(getDataCiteService().styleVerdicts.get(style)).toBeUndefined();
    },
  );

  it('answers a 404 under a requested style with the miss arm and no verdict', async () => {
    const doi = '10.1038/nature12373';
    const missing = () => fixtureResponse('datacite/errors/negotiation-404.json', { status: 404 });
    const { http } = initServices([
      { match: negotiation(doi, { style: 'ieee' }), respond: missing() },
      { match: negotiation(doi), respond: missing() },
      { match: doiRa(doi), respond: fixtureResponse('doi-ra/crossref.json') },
    ]);
    const out = output(await run({ doi, style: 'ieee' }));
    expect(out).toMatchObject({ found: false, missReason: 'other_agency' });
    expect(getDataCiteService().styleVerdicts.get('ieee')).toBeUndefined();
    expect(http.calls).toHaveLength(3);
  });

  it('answers a 404 with the miss arm even when the default rendering beside it fails', async () => {
    const doi = '10.1038/nature12373';
    const { http } = initServices([
      {
        match: negotiation(doi, { style: 'ieee' }),
        respond: fixtureResponse('datacite/errors/negotiation-404.json', { status: 404 }),
      },
      { match: negotiation(doi), respond: rateLimitResponse() },
      { match: doiRa(doi), respond: fixtureResponse('doi-ra/crossref.json') },
    ]);
    const result = await run({ doi, style: 'ieee' });
    expect(result.isError).toBeFalsy();
    expect(output(result)).toMatchObject({
      found: false,
      missReason: 'other_agency',
      registrationAgency: 'Crossref',
    });
    expect(contentText(result)).toContain('**Miss reason:** other_agency');
    expect(getDataCiteService().styleVerdicts.get('ieee')).toBeUndefined();
    expect(http.calls).toHaveLength(3);
  });

  it.each([
    { name: 'fails (budget spent)', respond: () => rateLimitResponse() },
    {
      name: 'answers 404 (a stale cached miss)',
      respond: () => fixtureResponse('datacite/errors/negotiation-404.json', { status: 404 }),
    },
    { name: 'answers an empty 200', respond: () => text('') },
    {
      name: 'answers 400',
      respond: () =>
        fixtureResponse('datacite/errors/negotiation-400-unrenderable.json', { status: 400 }),
    },
  ])(
    'returns the requested rendering unverified, with a notice and no verdict, when the default rendering $name',
    async ({ respond }) => {
      initServices([
        { match: negotiation(DOI, { style: 'ieee' }), respond: html(IEEE_HTML) },
        { match: negotiation(DOI), respond },
      ]);
      const result = await run({ doi: DOI, style: 'ieee' });
      expect(result.isError).toBeFalsy();
      const notice =
        'The style check could not complete, so it could not be confirmed that ieee was applied: DataCite answers an unsupported style with the default APA rendering, and this one could not be compared with that default.';
      expect(output(result)).toMatchObject({
        found: true,
        style: 'ieee',
        citationHtml: IEEE_HTML.trim(),
        notice,
      });
      expect(contentText(result)).toContain(`> ${notice}`);
      expect(getDataCiteService().styleVerdicts.get('ieee')).toBeUndefined();
    },
  );

  it('fails with rate_limited when the requested rendering itself cannot be fetched', async () => {
    initServices([
      { match: negotiation(DOI, { style: 'ieee' }), respond: rateLimitResponse() },
      { match: negotiation(DOI), respond: html(DEFAULT_HTML) },
    ]);
    const result = await run({ doi: DOI, style: 'ieee' });
    const error = expectToolError(result, 'rate_limited', JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ retryable: true });
    expect(getDataCiteService().styleVerdicts.get('ieee')).toBeUndefined();
  });

  it.each(UNRENDERABLE)(
    'reports $name under a requested style as format_unavailable and caches no verdict',
    async ({ respond, detail }) => {
      initServices([
        { match: negotiation(DOI, { style: 'ieee' }), respond },
        { match: negotiation(DOI), respond },
      ]);
      const result = await run({ doi: DOI, style: 'ieee' });
      const error = expectToolError(result, 'format_unavailable', JsonRpcErrorCode.NotFound);
      expect(error.message).toBe(`DataCite cannot render this DOI in text (${detail}).`);
      expect(contentText(result)).toContain(FORMAT_UNAVAILABLE_RECOVERY);
      expect(getDataCiteService().styleVerdicts.get('ieee')).toBeUndefined();
    },
  );
});

describe('locales', () => {
  it.each([
    ['de', 'de-DE'],
    ['en_gb', 'en-GB'],
    ['DE-at', 'de-AT'],
    ['sr-latn-rs', 'sr-Latn-RS'],
  ])('resolves %j to the CSL locale %j and sends it', async (locale, resolved) => {
    const body = `Rendered in ${resolved} (constructed).`;
    const { http } = initServices([
      { match: negotiation(DOI, { locale: resolved }), respond: html(body) },
    ]);
    const result = await run({ doi: DOI, locale });
    expect(output(result)).toMatchObject({ found: true, style: 'apa', locale: resolved });
    expect(contentText(result)).toContain(`· **Style:** apa · **Locale:** ${resolved}`);
    expect(http.calls).toHaveLength(1);
  });

  it('rejects a locale outside the CSL list as unsupported_locale before any request', async () => {
    const { http } = initServices([]);
    const result = await run({ doi: DOI, locale: 'xx-XX' });
    const error = expectToolError(result, 'unsupported_locale', JsonRpcErrorCode.ValidationError);
    expect(error.message).not.toContain('xx-XX');
    expect(contentText(result)).toContain('Recovery: Pass a CSL locale such as en-GB, de-DE');
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    { locale: 'tl-PH' },
    { locale: 'hy-AM' },
    { locale: 'tl' },
    { locale: 'hy' },
    { locale: 'hy', style: 'harvard-cite-them-right' },
  ])(
    'rejects %j, a CSL locale DataCite renders as APA in US English, as unsupported_locale before any request',
    async (input) => {
      const { http } = initServices([]);
      const result = await run({ doi: DOI, ...input });
      expectToolError(result, 'unsupported_locale', JsonRpcErrorCode.ValidationError);
      expect(contentText(result)).toContain(
        'Error: locale is not a CSL locale DataCite renders; DataCite would silently render the whole citation as APA in US English.',
      );
      expect(http.calls).toHaveLength(0);
    },
  );
});

describe('machine formats', () => {
  it.each([
    ['csl_json', 'application/vnd.citationstyles.csl+json', 'json'],
    ['bibtex', 'application/x-bibtex', 'bibtex'],
    ['ris', 'application/x-research-info-systems', ''],
    ['datacite_json', 'application/vnd.datacite.datacite+json', 'json'],
    ['datacite_xml', 'application/vnd.datacite.datacite+xml', 'xml'],
    ['schema_org', 'application/vnd.schemaorg.ld+json', 'json'],
    ['codemeta', 'application/vnd.codemeta.ld+json', 'json'],
    ['jats', 'application/vnd.jats+xml', 'xml'],
  ] as const)(
    'negotiates %s at %s with the MIME unencoded and fences it as %j',
    async (format, mime, fence) => {
      const payload = `payload for ${format}\n`;
      const { http } = initServices([
        { match: negotiation(DOI, {}, mime), respond: text(payload) },
      ]);
      const result = await run({ doi: DOI, format });
      const out = output(result);
      expect(out).toEqual({
        found: true,
        doi: DOI,
        format,
        mediaType: mime,
        citation: payload,
      });
      expect(contentText(result)).toContain(
        `**Found:** true · **Format:** ${format} (${mime})\n\n\`\`\`${fence}\npayload for ${format}\n\`\`\``,
      );
      expect(requestUrl(http).pathname).toBe(`/dois/${mime}/10.5061%2Fdryad.8515`);
    },
  );

  it('returns a recorded CSL JSON payload verbatim', async () => {
    const payload = fixtureText('datacite/citations/dryad-8515-csl.json');
    initServices([
      {
        match: negotiation(DOI, {}, 'application/vnd.citationstyles.csl+json'),
        respond: text(payload),
      },
    ]);
    const result = await run({ doi: DOI, format: 'csl_json' });
    expect(output(result).citation).toBe(payload);
    expect(contentText(result)).toContain(`\`\`\`json\n${payload.trimEnd()}\n\`\`\``);
  });

  it('returns a recorded BibTeX payload verbatim', async () => {
    const doi = '10.5281/zenodo.3509134';
    const payload = fixtureText('datacite/citations/zenodo-3509134-bibtex.bib');
    initServices([{ match: negotiation(doi, {}, 'application/x-bibtex'), respond: text(payload) }]);
    const result = await run({ doi, format: 'bibtex' });
    expect(output(result).citation).toBe(payload);
    expect(contentText(result)).toContain(`\`\`\`bibtex\n${payload.trimEnd()}\n\`\`\``);
  });

  it('fences a payload with a fence longer than its longest backtick run', async () => {
    const payload = '{"description":"Run ```` then ` and ``"}';
    initServices([
      {
        match: negotiation(DOI, {}, 'application/vnd.datacite.datacite+json'),
        respond: text(payload),
      },
    ]);
    const content = contentText(await run({ doi: DOI, format: 'datacite_json' }));
    expect(content).toContain(`\`\`\`\`\`json\n${payload}\n\`\`\`\`\``);
  });

  it.each([
    ['schema.org', 'schema_org'],
    ['schemaorg_jsonld', 'schema_org'],
    ['CSL-JSON', 'csl_json'],
    ['BibTeX', 'bibtex'],
    ['Datacite XML', 'datacite_xml'],
  ])('accepts the format spelling %j as %s', async (spelling, format) => {
    const { http } = initServices([
      {
        match: (request: Request) => new URL(request.url).pathname.endsWith(`/${DOI_PATH}`),
        respond: text('x'),
      },
    ]);
    const out = output(await run({ doi: DOI, format: spelling } as Input));
    expect(out.format).toBe(format);
    expect(requestUrl(http).pathname).toBe(`/dois/${out.mediaType}/${DOI_PATH}`);
  });

  it('treats a blank format as text', async () => {
    const { http } = initServices([{ match: negotiation(DOI), respond: html(DEFAULT_HTML) }]);
    const out = output(await run({ doi: DOI, format: ' ' } as Input));
    expect(out.format).toBe('text');
    expect(http.calls).toHaveLength(1);
  });

  it('ignores blank style and locale with a machine format', async () => {
    const { http } = initServices([
      { match: negotiation(DOI, {}, 'application/x-bibtex'), respond: text('@misc{x}') },
    ]);
    const out = output(await run({ doi: DOI, format: 'bibtex', style: '', locale: ' ' }));
    expect(out).toMatchObject({ found: true, format: 'bibtex', citation: '@misc{x}' });
    expect(http.calls).toHaveLength(1);
  });
});

describe('payload size', () => {
  const CAP = 100_000;
  const DATACITE_JSON = 'application/vnd.datacite.datacite+json';
  const count = (n: number) => n.toLocaleString('en-US');
  const sizeNotice = (format: string, total: number, shown = CAP) =>
    `The ${format} payload runs to ${count(total)} characters, past the ${count(CAP)} this tool returns, so it is cut to its first ${count(shown)}. datacite_get_work returns the record with each long list capped and its full count reported.`;

  it('returns the first 100,000 characters of a longer payload and discloses the cut on both surfaces', async () => {
    const payload = `{"id":"x","filler":"${'a'.repeat(2_000_000)}"}`;
    initServices([{ match: negotiation(DOI, {}, DATACITE_JSON), respond: text(payload) }]);
    const result = await run({ doi: DOI, format: 'datacite_json' });
    const out = output(result);
    expect(out.citation).toBe(payload.slice(0, CAP));
    expect(out).toMatchObject({
      truncated: true,
      shown: CAP,
      cap: CAP,
      notice: sizeNotice('datacite_json', payload.length),
    });
    const content = contentText(result);
    expect(content).toContain(`\`\`\`json\n${payload.slice(0, CAP)}\n\`\`\``);
    expect(content).toContain(`> ${sizeNotice('datacite_json', payload.length)}`);
    expect(content.length).toBeLessThan(CAP + 2_000);
  });

  it('returns a payload of exactly 100,000 characters whole, with no disclosure', async () => {
    const payload = 'a'.repeat(CAP);
    initServices([{ match: negotiation(DOI, {}, DATACITE_JSON), respond: text(payload) }]);
    const result = await run({ doi: DOI, format: 'datacite_json' });
    expect(output(result)).toEqual({
      found: true,
      doi: DOI,
      format: 'datacite_json',
      mediaType: DATACITE_JSON,
      citation: payload,
    });
    expect(contentText(result)).not.toContain('payload runs to');
  });

  it('never splits a surrogate pair at the cut', async () => {
    const payload = `${'a'.repeat(CAP - 1)}😀 tail`;
    initServices([{ match: negotiation(DOI, {}, DATACITE_JSON), respond: text(payload) }]);
    const out = output(await run({ doi: DOI, format: 'datacite_json' }));
    expect(out.citation).toBe('a'.repeat(CAP - 1));
    expect(out).toMatchObject({ truncated: true, shown: CAP - 1, cap: CAP });
  });

  it('cuts a formatted citation before deriving its text, keeping a style notice beside the disclosure', async () => {
    const style = 'apa-single-spaced';
    const htmlBody = `${'Author, A., '.repeat(10_000)}(2020). <i>Big</i>.`;
    initServices([{ match: negotiation(DOI, { style }), respond: html(htmlBody) }]);
    getDataCiteService().styleVerdicts.set(style, 'apa_variant_unconfirmed', 86_400_000);
    const result = await run({ doi: DOI, style });
    const out = output(result);
    expect(out.citationHtml).toBe(htmlBody.slice(0, CAP));
    expect(out.citation).toBe(htmlBody.slice(0, CAP).trim());
    const notice = `${CACHED_APA_VARIANT_NOTICE} ${sizeNotice('text', htmlBody.length)}`;
    expect(out).toMatchObject({ truncated: true, shown: CAP, cap: CAP, notice });
    const content = contentText(result);
    expect(content).toContain(`> ${notice}`);
    expect(content.length).toBeLessThan(2 * CAP + 3_000);
  });
});

describe('the miss arm', () => {
  it.each([
    {
      doi: '10.1038/nature12373',
      ra: 'doi-ra/crossref.json',
      expected: {
        missReason: 'other_agency',
        registrationAgency: 'Crossref',
        guidance:
          "10.1038/nature12373 is registered with Crossref, not DataCite, so DataCite cannot format it. Request it from Crossref's own content negotiation at https://doi.org/10.1038/nature12373 (for example with Accept: text/x-bibliography), or call datacite_trace_relations to find DataCite works linked to it.",
      },
    },
    {
      doi: '10.9999/doesnotexist',
      ra: 'doi-ra/does-not-exist.json',
      expected: {
        missReason: 'does_not_exist',
        guidance:
          'No agency has registered 10.9999/doesnotexist. Check it for typos or truncation, or find the work by title with datacite_search_works (text).',
      },
    },
    {
      doi: '10.5061/dryad.8515',
      ra: 'doi-ra/datacite.json',
      expected: {
        missReason: 'not_public',
        registrationAgency: 'DataCite',
        guidance:
          '10.5061/dryad.8515 is a DataCite DOI without public (Findable) metadata — it may be in Registered or Draft state, or registered minutes ago. Retry later, or search by title with datacite_search_works.',
      },
    },
  ])(
    'answers a 404 for $doi with found: false and $expected.missReason',
    async ({ doi, ra, expected }) => {
      const { http } = initServices([
        {
          match: negotiation(doi),
          respond: fixtureResponse('datacite/errors/negotiation-404.json', { status: 404 }),
        },
        { match: doiRa(doi), respond: fixtureResponse(ra) },
      ]);
      const result = await run({ doi });
      expect(result.isError).toBeFalsy();
      expect(output(result)).toEqual({ found: false, doi, format: 'text', ...expected });
      const content = contentText(result);
      expect(content).toContain(`**Not found in DataCite** — ${doi}`);
      expect(content).toContain('**Found:** false · **Format:** text\n');
      expect(content).toContain(`**Miss reason:** ${expected.missReason}`);
      expect(content).toContain(expected.guidance);
      expect(content).not.toContain('```');
      expect(http.calls).toHaveLength(2);
    },
  );

  it.each([
    {
      format: 'bibtex',
      guidance:
        "10.1038/nature12373 is registered with Crossref, not DataCite, so DataCite cannot format it. Request it from Crossref's own content negotiation at https://doi.org/10.1038/nature12373 (for example with Accept: application/x-bibtex), or call datacite_trace_relations to find DataCite works linked to it.",
    },
    {
      format: 'jats',
      guidance:
        "10.1038/nature12373 is registered with Crossref, not DataCite, so DataCite cannot format it, and only DataCite's content negotiation serves JATS XML. Request CSL JSON or BibTeX from Crossref's own content negotiation at https://doi.org/10.1038/nature12373 (for example with Accept: application/vnd.citationstyles.csl+json), or call datacite_trace_relations to find DataCite works linked to it.",
    },
  ] as const)(
    'fits the other-agency guidance to a $format request',
    async ({ format, guidance }) => {
      const doi = '10.1038/nature12373';
      initServices([
        {
          match: negotiation(doi, {}, CITATION_FORMATS[format]),
          respond: fixtureResponse('datacite/errors/negotiation-404.json', { status: 404 }),
        },
        { match: doiRa(doi), respond: fixtureResponse('doi-ra/crossref.json') },
      ]);
      const result = await run({ doi, format });
      expect(output(result)).toEqual({
        found: false,
        doi,
        format,
        missReason: 'other_agency',
        registrationAgency: 'Crossref',
        guidance,
      });
      const content = contentText(result);
      expect(content).toContain(`**Found:** false · **Format:** ${format}\n`);
      expect(content).toContain(guidance);
      expect(content).not.toContain('text/x-bibliography');
    },
  );

  it('flattens the registration agency inside the guidance and keeps it verbatim in structuredContent', async () => {
    const doi = '10.1038/nature12373';
    const agency = 'Crossref\n# INJECTED heading\r\n- INJECTED bullet';
    initServices([
      {
        match: negotiation(doi),
        respond: fixtureResponse('datacite/errors/negotiation-404.json', { status: 404 }),
      },
      { match: doiRa(doi), respond: json([{ DOI: doi, RA: agency }]) },
    ]);
    const result = await run({ doi });
    const out = output(result);
    expect(out.registrationAgency).toBe(agency);
    expect(out.guidance).toContain(`registered with ${agency}, not DataCite`);
    const content = contentText(result);
    expect(content).toContain(
      'registered with Crossref # INJECTED heading - INJECTED bullet, not DataCite',
    );
    expect(content).not.toMatch(/^(#|-) INJECTED/m);
  });
});

describe('declared errors and input', () => {
  it('logs the input-caused reasons at notice, an unrenderable format at info, and upstream faults at error', () => {
    expect(declaredSeverities(getCitationTool.errors)).toEqual({
      invalid_doi: 'notice',
      unsupported_style: 'notice',
      unsupported_locale: 'notice',
      style_requires_text: 'notice',
      format_unavailable: 'info',
      render_failed: 'error',
      rate_limited: 'error',
    });
  });

  it('encodes the whole DOI into the path', async () => {
    const doi = '10.5555/a,b(c)/d';
    const { http } = initServices([
      {
        match: dataCite('/dois/text/x-bibliography/10.5555%2Fa%2Cb(c)%2Fd'),
        respond: html(TERSE_HTML),
      },
    ]);
    const out = output(await run({ doi: `https://doi.org/${doi.toUpperCase()}` }));
    expect(out).toMatchObject({ found: true, doi });
    expect(http.calls).toHaveLength(1);
  });

  it('cites a DOI holding a literal percent-escape as written', async () => {
    const doi = '10.18716/nmrshiftdb2/60004113/mrc_methanol-d4%20%28cd3od%29';
    const { http } = initServices([{ match: negotiation(doi), respond: html(TERSE_HTML) }]);
    const result = await run({ doi });
    expect(result.isError).toBeFalsy();
    expect(output(result)).toMatchObject({ found: true, doi });
    expect(contentText(result)).toContain(`**Citation** — ${doi}`);
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    { format: 'bibtex', style: 'ieee' },
    { format: 'csl_json', locale: 'de' },
    { format: 'ris', locale: 'xx-XX' },
  ] as const)('rejects %j as style_requires_text before any request', async (input) => {
    const { http } = initServices([]);
    const result = await run({ doi: DOI, ...input });
    const error = expectToolError(result, 'style_requires_text', JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe(`style and locale apply only to format text, not ${input.format}.`);
    expect(contentText(result)).toContain('Recovery: Drop style and locale, or set format to text');
    expect(http.calls).toHaveLength(0);
  });

  it.each(
    UNRENDERABLE.flatMap((answer) =>
      (['text', 'bibtex', 'datacite_xml'] as const).map((format) => ({ ...answer, format })),
    ),
  )(
    'reports $name for $format as format_unavailable, naming another format, in one request',
    async ({ format, respond, detail }) => {
      const { http } = initServices([
        { match: negotiation(DOI, {}, CITATION_FORMATS[format]), respond },
      ]);
      const result = await run({ doi: DOI, format });
      const error = expectToolError(result, 'format_unavailable', JsonRpcErrorCode.NotFound);
      const message = `DataCite cannot render this DOI in ${format} (${detail}).`;
      expect(error.message).toBe(message);
      expect(error.data).not.toHaveProperty('body');
      const content = contentText(result);
      expect(content).toContain(`Error: ${message}`);
      expect(content).toContain(FORMAT_UNAVAILABLE_RECOVERY);
      expect(content).toContain('(reason format_unavailable)');
      expect(http.calls).toHaveLength(1);
    },
  );

  it.each([
    {
      input: { format: 'codemeta' },
      mime: 'application/vnd.codemeta.ld+json',
      query: {},
      calls: 3,
    },
    // Three attempts at the requested rendering, plus the default rendering beside it.
    { input: { style: 'ieee' }, mime: 'text/x-bibliography', query: { style: 'ieee' }, calls: 4 },
  ] as const)(
    'names another format as the next step when DataCite answers 5xx on every attempt for $input',
    async ({ input, mime, query, calls }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const { http } = initServices([
        {
          match: negotiation(DOI, query, mime),
          respond: () =>
            fixtureResponse('datacite/errors/negotiation-500-unrenderable.json', { status: 500 }),
        },
        { match: negotiation(DOI), respond: html(DEFAULT_HTML) },
      ]);
      const pending = run({ doi: DOI, ...input });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      const error = expectToolError(result, 'render_failed', JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toBe('DataCite returned HTTP 500. (failed after 3 attempts)');
      expect(error.data).toMatchObject({ status: 500, retryable: true });
      const content = contentText(result);
      expect(content).toContain(
        'Recovery: Request another format such as datacite_json or csl_json, or call datacite_get_work for the full record; retry this format later, since DataCite also answers a brief outage with HTTP 5xx.',
      );
      expect(content).toContain('(reason render_failed · retryable)');
      expect(http.calls).toHaveLength(calls);
      expect(getDataCiteService().styleVerdicts.get('ieee')).toBeUndefined();
    },
  );

  it.each(['10.12/x', '10.5061/', 'https://doi.org/10.5061/'])(
    'rejects %j as invalid_doi before any request',
    async (doi) => {
      const { http } = initServices([]);
      const result = await run({ doi });
      expectToolError(result, 'invalid_doi', JsonRpcErrorCode.ValidationError);
      expect(contentText(result)).toContain('Recovery: Pass a DOI such as 10.5061/dryad.234');
      expect(http.calls).toHaveLength(0);
    },
  );

  it('surfaces an exhausted DataCite budget as rate_limited with the wait', async () => {
    const { http } = initServices([{ match: negotiation(DOI), respond: rateLimitResponse() }]);
    const result = await run({ doi: DOI });
    const error = expectToolError(result, 'rate_limited', JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ retryAfter: 30, retryable: true });
    expect(error.message).toContain('retry in 30 seconds');
    expect(contentText(result)).toContain('(reason rate_limited · retryable)');
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    { doi: 'dryad.8515' },
    { doi: DOI, style: 'ieee style' },
    { doi: DOI, style: 'chicago_author_date' },
    { doi: DOI, locale: 'english' },
    { doi: DOI, locale: 'd' },
    { doi: DOI, locale: 'de-DE-x-foo' },
    { doi: DOI, format: 'pdf' },
  ])('rejects the malformed input %j at the schema', async (input) => {
    const { http } = initServices([]);
    const result = await run(input as Input);
    const error = expectToolError(result, 'invalid_arguments', JsonRpcErrorCode.InvalidParams);
    expect(error.message).toContain(Object.keys(input).at(-1) as string);
    expect(http.calls).toHaveLength(0);
  });
});
