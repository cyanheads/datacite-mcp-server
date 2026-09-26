/**
 * @fileoverview Citation vocabularies: the content-negotiation formats and their
 * media types, the CSL styles verified to render distinctly upstream, the known
 * silent fallbacks, and the 63 CSL locales with their primary dialects.
 * @module services/reference/citation
 */

/** Citation formats and the media type each negotiates. */
export const CITATION_FORMATS = {
  text: 'text/x-bibliography',
  csl_json: 'application/vnd.citationstyles.csl+json',
  bibtex: 'application/x-bibtex',
  ris: 'application/x-research-info-systems',
  datacite_json: 'application/vnd.datacite.datacite+json',
  datacite_xml: 'application/vnd.datacite.datacite+xml',
  schema_org: 'application/vnd.schemaorg.ld+json',
  codemeta: 'application/vnd.codemeta.ld+json',
  jats: 'application/vnd.jats+xml',
} as const;
export type CitationFormat = keyof typeof CITATION_FORMATS;
export const CITATION_FORMAT_IDS = Object.keys(CITATION_FORMATS) as [
  CitationFormat,
  ...CitationFormat[],
];

export const CITATION_FORMAT_LABELS: Record<CitationFormat, string> = {
  text: 'Formatted citation (CSL style + locale)',
  csl_json: 'CSL JSON',
  bibtex: 'BibTeX',
  ris: 'RIS',
  datacite_json: 'DataCite JSON',
  datacite_xml: 'DataCite XML',
  schema_org: 'Schema.org JSON-LD',
  codemeta: 'Codemeta JSON-LD',
  jats: 'JATS XML',
};

/** CSL style ids verified to render distinctly upstream. */
export const VERIFIED_CITATION_STYLES = [
  'apa',
  'apa-6th-edition',
  'modern-language-association',
  'chicago-author-date',
  'chicago-author-date-17th-edition',
  'chicago-notes-bibliography',
  'ieee',
  'vancouver',
  'vancouver-brackets',
  'vancouver-superscript',
  'elsevier-vancouver',
  'harvard-cite-them-right',
  'elsevier-harvard',
  'nature',
  'science',
  'cell',
  'plos',
  'frontiers',
  'american-medical-association',
  'american-chemical-society',
  'american-sociological-association',
  'american-political-science-association',
  'american-institute-of-physics',
  'royal-society-of-chemistry',
  'council-of-science-editors',
  'springer-basic-author-date',
  'the-lancet',
  'bmj',
  'iso690-author-date-en',
  'din-1505-2',
  'copernicus-publications',
  'bibtex',
] as const;

/** Style ids known to fall back silently to APA upstream. */
export const FALLBACK_CITATION_STYLES: ReadonlyArray<{ note: string; value: string }> = [
  { value: 'mla', note: 'Not a CSL id; use modern-language-association.' },
  { value: 'chicago-fullnote-bibliography', note: 'Retired id; use chicago-notes-bibliography.' },
  { value: 'chicago-note-bibliography', note: 'Retired id; use chicago-notes-bibliography.' },
  { value: 'turabian-fullnote-bibliography', note: 'Retired id.' },
  {
    value: 'nature-communications',
    note: 'A dependent journal style; use its independent parent (nature).',
  },
];

/** The 63 CSL locales with English names. */
export const CSL_LOCALES: ReadonlyArray<[locale: string, name: string]> = [
  ['af-ZA', 'Afrikaans'],
  ['ar', 'Arabic'],
  ['bal-PK', 'Balochi (Pakistan)'],
  ['bg-BG', 'Bulgarian'],
  ['brh-PK', 'Brahui'],
  ['ca-AD', 'Catalan'],
  ['cs-CZ', 'Czech'],
  ['cy-GB', 'Welsh'],
  ['da-DK', 'Danish'],
  ['de-AT', 'German (Austria)'],
  ['de-CH', 'German (Switzerland)'],
  ['de-DE', 'German (Germany)'],
  ['el-GR', 'Greek'],
  ['en-GB', 'English (UK)'],
  ['en-US', 'English (US)'],
  ['es-CL', 'Spanish (Chile)'],
  ['es-ES', 'Spanish (Spain)'],
  ['es-MX', 'Spanish (Mexico)'],
  ['et-EE', 'Estonian'],
  ['eu', 'Basque'],
  ['fa-IR', 'Persian'],
  ['fi-FI', 'Finnish'],
  ['fr-CA', 'French (Canada)'],
  ['fr-FR', 'French (France)'],
  ['gl-ES', 'Galician (Spain)'],
  ['he-IL', 'Hebrew'],
  ['hi-IN', 'Hindi'],
  ['hr-HR', 'Croatian'],
  ['hu-HU', 'Hungarian'],
  ['hy-AM', 'Armenian'],
  ['id-ID', 'Indonesian'],
  ['is-IS', 'Icelandic'],
  ['it-IT', 'Italian'],
  ['ja-JP', 'Japanese'],
  ['km-KH', 'Khmer'],
  ['ko-KR', 'Korean'],
  ['la', 'Latin'],
  ['lij-IT', 'Ligurian'],
  ['lt-LT', 'Lithuanian'],
  ['lv-LV', 'Latvian'],
  ['mn-MN', 'Mongolian'],
  ['ms-MY', 'Malay'],
  ['nb-NO', 'Norwegian (Bokmål)'],
  ['nl-NL', 'Dutch'],
  ['nn-NO', 'Norwegian (Nynorsk)'],
  ['pa-PK', 'Punjabi (Shahmukhi)'],
  ['pl-PL', 'Polish'],
  ['pt-BR', 'Portuguese (Brazil)'],
  ['pt-PT', 'Portuguese (Portugal)'],
  ['ro-RO', 'Romanian'],
  ['ru-RU', 'Russian'],
  ['sk-SK', 'Slovak'],
  ['sl-SI', 'Slovenian'],
  ['sr-Cyrl-RS', 'Serbian (Cyrillic)'],
  ['sr-Latn-RS', 'Serbian (Latin)'],
  ['sv-SE', 'Swedish'],
  ['th-TH', 'Thai'],
  ['tl-PH', 'Tagalog'],
  ['tr-TR', 'Turkish'],
  ['uk-UA', 'Ukrainian'],
  ['vi-VN', 'Vietnamese'],
  ['zh-CN', 'Chinese (PRC)'],
  ['zh-TW', 'Chinese (Taiwan)'],
];

/** CSL primary dialects: the full locale a bare language code selects. */
export const CSL_PRIMARY_DIALECTS: Readonly<Record<string, string>> = {
  af: 'af-ZA',
  ar: 'ar',
  bal: 'bal-PK',
  bg: 'bg-BG',
  brh: 'brh-PK',
  ca: 'ca-AD',
  cs: 'cs-CZ',
  cy: 'cy-GB',
  da: 'da-DK',
  de: 'de-DE',
  el: 'el-GR',
  en: 'en-US',
  es: 'es-ES',
  et: 'et-EE',
  eu: 'eu',
  fa: 'fa-IR',
  fi: 'fi-FI',
  fr: 'fr-FR',
  gl: 'gl-ES',
  he: 'he-IL',
  hi: 'hi-IN',
  hr: 'hr-HR',
  hu: 'hu-HU',
  hy: 'hy-AM',
  id: 'id-ID',
  is: 'is-IS',
  it: 'it-IT',
  ja: 'ja-JP',
  km: 'km-KH',
  ko: 'ko-KR',
  la: 'la',
  lij: 'lij-IT',
  lt: 'lt-LT',
  lv: 'lv-LV',
  mn: 'mn-MN',
  ms: 'ms-MY',
  nb: 'nb-NO',
  nl: 'nl-NL',
  nn: 'nn-NO',
  pa: 'pa-PK',
  pl: 'pl-PL',
  pt: 'pt-PT',
  ro: 'ro-RO',
  ru: 'ru-RU',
  sk: 'sk-SK',
  sl: 'sl-SI',
  sr: 'sr-Latn-RS',
  sv: 'sv-SE',
  th: 'th-TH',
  tl: 'tl-PH',
  tr: 'tr-TR',
  uk: 'uk-UA',
  vi: 'vi-VN',
  zh: 'zh-CN',
};

const LOCALES_BY_KEY = new Map([
  ...Object.entries(CSL_PRIMARY_DIALECTS),
  ...CSL_LOCALES.map(([locale]): [string, string] => [locale.toLowerCase(), locale]),
]);

/**
 * Resolves a caller's locale to a CSL locale: a full locale in any case
 * (`de-de` → `de-DE`, `_` accepted for `-`), or a bare language code expanded to
 * its CSL primary dialect (`de` → `de-DE`). `undefined` when CSL has no match.
 */
export function resolveCslLocale(value: string): string | undefined {
  const key = value.trim().replace(/_/g, '-').toLowerCase();
  return LOCALES_BY_KEY.get(key);
}

/** A pinned multi-creator, versioned DataCite dataset whose rendering differs across independent styles. */
export const STYLE_CANARY_DOI = '10.5061/dryad.234';
