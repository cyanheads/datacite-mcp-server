/**
 * @fileoverview Citation rendering through content negotiation, with the style
 * verdict that catches the upstream's silent APA fallback: a requested style
 * rendering identical to the DOI's default is settled by rendering a pinned
 * canary record in the same style. Verdicts depend on the style id alone and are
 * cached for 24 h.
 * @module services/datacite/citation
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  CITATION_FORMATS,
  type CitationFormat,
  STYLE_CANARY_DOI,
} from '@/services/reference/citation.js';
import type { DataCiteService, NegotiationResult, StyleVerdict } from './datacite-service.js';

const VERDICT_TTL_MS = 24 * 60 * 60_000;
const TEXT = CITATION_FORMATS.text;

export interface CitationRequest {
  doi: string;
  format: CitationFormat;
  locale?: string;
  /** Lowercase CSL style id; omitted means the default (apa). */
  style?: string;
}

export type CitationOutcome =
  | { body: string; kind: 'rendered'; notice?: string }
  | { kind: 'not_found' }
  | { kind: 'no_content' }
  | { kind: 'unsupported_style' };

const isApaVariant = (style: string): boolean => style === 'apa' || style.startsWith('apa-');

function outcomeOf(result: NegotiationResult, notice?: string): CitationOutcome {
  if (result.status === 404) return { kind: 'not_found' };
  if (result.status === 204) return { kind: 'no_content' };
  return { kind: 'rendered', body: result.body, ...(notice && { notice }) };
}

const APA_LAYOUT_CAUSE = 'APA variants that differ only in layout cannot be told apart from APA';

const unconfirmedNotice = (style: string, cause: string): string =>
  `The ${style} rendering is identical to the default APA output and ${cause}, so it could not be confirmed that ${style} was applied; treat this as APA text if the two styles should differ.`;

/**
 * The cached-verdict counterpart of `unconfirmedNotice`: this call compared no
 * rendering (and a locale call's rendering can differ from the default), so it
 * states the earlier style-level finding rather than a per-record identity.
 */
const cachedUnconfirmedNotice = (style: string): string =>
  `An earlier check found ${style} rendering the same text as the default APA style, and ${APA_LAYOUT_CAUSE}, so it could not be confirmed that ${style} was applied; treat this as APA text if the two styles should differ.`;

const uncomparedNotice = (style: string): string =>
  `The style check could not complete, so it could not be confirmed that ${style} was applied: DataCite answers an unsupported style with the default APA rendering, and this one could not be compared with that default.`;

/**
 * Renders one DOI in the requested format, style, and locale. The default
 * rendering and the canary pair are evidence for the style verdict only: when
 * either cannot be compared, the requested answer (rendering, miss, or 204)
 * still stands, the style stays unverified, and no verdict is cached.
 */
export async function renderCitation(
  service: DataCiteService,
  request: CitationRequest,
  ctx: Context,
): Promise<CitationOutcome> {
  const { doi, style } = request;
  if (request.format !== 'text') {
    return outcomeOf(await service.negotiate(doi, CITATION_FORMATS[request.format], {}, ctx));
  }

  const params = {
    ...(style && { style }),
    ...(request.locale && { locale: request.locale }),
  };
  if (!style || style === 'apa') return outcomeOf(await service.negotiate(doi, TEXT, params, ctx));

  const verdict = service.styleVerdicts.get(style);
  if (verdict === 'unsupported') return { kind: 'unsupported_style' };
  if (verdict === 'supported') return outcomeOf(await service.negotiate(doi, TEXT, params, ctx));
  if (verdict === 'apa_variant_unconfirmed') {
    return outcomeOf(
      await service.negotiate(doi, TEXT, params, ctx),
      cachedUnconfirmedNotice(style),
    );
  }

  const [settledRequest, settledFallback] = await Promise.allSettled([
    service.negotiate(doi, TEXT, params, ctx),
    service.negotiate(doi, TEXT, {}, ctx),
  ]);
  if (settledRequest.status === 'rejected') throw settledRequest.reason;
  const requested = settledRequest.value;
  if (requested.status !== 200) return outcomeOf(requested);
  if (settledFallback.status === 'rejected' || settledFallback.value.status !== 200) {
    if (settledFallback.status === 'rejected' && ctx.signal.aborted) throw settledFallback.reason;
    ctx.log.warning('Style check could not complete', { style });
    return outcomeOf(requested, uncomparedNotice(style));
  }
  const remember = (value: StyleVerdict) => service.styleVerdicts.set(style, value, VERDICT_TTL_MS);
  if (requested.body !== settledFallback.value.body) {
    remember('supported');
    return outcomeOf(requested);
  }

  let canaryDiffers: boolean;
  try {
    const [canaryStyled, canaryDefault] = await Promise.all([
      service.negotiate(STYLE_CANARY_DOI, TEXT, { style }, ctx),
      service.negotiate(STYLE_CANARY_DOI, TEXT, {}, ctx),
    ]);
    if (canaryStyled.status !== 200 || canaryDefault.status !== 200) {
      throw new Error(`canary answered ${canaryStyled.status}/${canaryDefault.status}`);
    }
    canaryDiffers = canaryStyled.body !== canaryDefault.body;
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    ctx.log.warning('Style check could not complete', { style });
    return outcomeOf(requested, unconfirmedNotice(style, 'the style check could not complete'));
  }

  if (canaryDiffers) {
    remember('supported');
    return outcomeOf(requested);
  }
  if (isApaVariant(style)) {
    remember('apa_variant_unconfirmed');
    return outcomeOf(requested, unconfirmedNotice(style, APA_LAYOUT_CAUSE));
  }
  remember('unsupported');
  return { kind: 'unsupported_style' };
}
