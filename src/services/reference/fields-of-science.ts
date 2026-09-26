/**
 * @fileoverview The OECD Fields of Science and Technology (FOS 2007) hierarchy —
 * six areas and 42 fields — with the canonical id DataCite's facet reports, the
 * label it stores, and the observed spelling variants of that label. Work search
 * matches a field through `subjects.subject` phrases built from these labels.
 * @module services/reference/fields-of-science
 */

import { buildResolver } from './lookup.js';

interface FieldOfScience {
  area: string;
  code: string;
  id: string;
  label: string;
  /** Other stored spellings of the same label, each searched alongside it. */
  variants?: readonly string[];
}

export const FIELD_OF_SCIENCE_IDS = [
  'natural_sciences',
  'mathematics',
  'computer_and_information_sciences',
  'physical_sciences',
  'chemical_sciences',
  'earth_and_related_environmental_sciences',
  'biological_sciences',
  'other_natural_sciences',
  'engineering_and_technology',
  'civil_engineering',
  'electrical_engineering_electronic_engineering_information_engineering',
  'mechanical_engineering',
  'chemical_engineering',
  'materials_engineering',
  'medical_engineering',
  'environmental_engineering',
  'environmental_biotechnology',
  'industrial_biotechnology',
  'nanotechnology',
  'other_engineering_and_technologies',
  'medical_and_health_sciences',
  'basic_medicine',
  'clinical_medicine',
  'health_sciences',
  'medical_biotechnology',
  'other_medical_sciences',
  'agricultural_sciences',
  'agriculture_forestry_and_fisheries',
  'animal_and_dairy_science',
  'veterinary_science',
  'agricultural_biotechnology',
  'other_agricultural_sciences',
  'social_sciences',
  'psychology',
  'economics_and_business',
  'educational_sciences',
  'sociology',
  'law',
  'political_science',
  'social_and_economic_geography',
  'media_and_communications',
  'other_social_sciences',
  'humanities',
  'history_and_archaeology',
  'languages_and_literature',
  'philosophy_ethics_and_religion',
  'arts_arts_history_of_arts_performing_arts_music',
  'other_humanities',
] as const;
export type FieldOfScienceId = (typeof FIELD_OF_SCIENCE_IDS)[number];

const AREAS: Record<string, string> = {
  '1': 'Natural sciences',
  '2': 'Engineering and technology',
  '3': 'Medical and health sciences',
  '4': 'Agricultural sciences',
  '5': 'Social sciences',
  '6': 'Humanities',
};

const LABELS: ReadonlyArray<[code: string, label: string, variants?: string[]]> = [
  ['1', 'Natural sciences'],
  ['1.1', 'Mathematics'],
  ['1.2', 'Computer and information sciences'],
  ['1.3', 'Physical sciences'],
  ['1.4', 'Chemical sciences'],
  ['1.5', 'Earth and related environmental sciences'],
  ['1.6', 'Biological sciences'],
  ['1.7', 'Other natural sciences'],
  ['2', 'Engineering and technology'],
  ['2.1', 'Civil engineering'],
  ['2.2', 'Electrical engineering, electronic engineering, information engineering'],
  ['2.3', 'Mechanical engineering'],
  ['2.4', 'Chemical engineering'],
  ['2.5', 'Materials engineering'],
  ['2.6', 'Medical engineering'],
  ['2.7', 'Environmental engineering'],
  ['2.8', 'Environmental biotechnology'],
  ['2.9', 'Industrial biotechnology'],
  ['2.10', 'Nanotechnology', ['Nano-technology']],
  ['2.11', 'Other engineering and technologies'],
  ['3', 'Medical and health sciences'],
  ['3.1', 'Basic medicine'],
  ['3.2', 'Clinical medicine'],
  ['3.3', 'Health sciences'],
  ['3.4', 'Medical biotechnology'],
  ['3.5', 'Other medical sciences'],
  ['4', 'Agricultural sciences'],
  ['4.1', 'Agriculture, forestry, and fisheries'],
  ['4.2', 'Animal and dairy science'],
  ['4.3', 'Veterinary science'],
  ['4.4', 'Agricultural biotechnology'],
  ['4.5', 'Other agricultural sciences'],
  ['5', 'Social sciences'],
  ['5.1', 'Psychology'],
  ['5.2', 'Economics and business'],
  ['5.3', 'Educational sciences'],
  ['5.4', 'Sociology'],
  ['5.5', 'Law'],
  ['5.6', 'Political science'],
  ['5.7', 'Social and economic geography'],
  ['5.8', 'Media and communications'],
  ['5.9', 'Other social sciences'],
  ['6', 'Humanities'],
  ['6.1', 'History and archaeology'],
  ['6.2', 'Languages and literature'],
  ['6.3', 'Philosophy, ethics and religion'],
  ['6.4', 'Arts (arts, history of arts, performing arts, music)'],
  ['6.5', 'Other humanities'],
];

/** Every area and field, keyed by canonical id, in OECD order. */
export const FIELDS_OF_SCIENCE: ReadonlyMap<FieldOfScienceId, FieldOfScience> = new Map(
  LABELS.map(([code, label, variants], index) => {
    const id = FIELD_OF_SCIENCE_IDS[index] as FieldOfScienceId;
    const area = AREAS[code.split('.')[0] as string] as string;
    return [id, { id, code, label, area, ...(variants && { variants }) }];
  }),
);

const resolveId = buildResolver(
  [...FIELDS_OF_SCIENCE.values()].map((field) => ({
    id: field.id as FieldOfScienceId,
    aliases: [field.label, ...(field.variants ?? [])],
  })),
);

/** Canonical id for an id, a label (with or without a `FOS:` prefix), or a known spelling variant. */
export const resolveFieldOfScience = (value: string): FieldOfScienceId | undefined =>
  resolveId(value.replace(/^\s*fos\s*:\s*/i, ''));

/** The stored labels a field is searched under: its label and every spelling variant. */
export function fieldOfScienceLabels(id: FieldOfScienceId): string[] {
  const field = FIELDS_OF_SCIENCE.get(id) as FieldOfScience;
  return [field.label, ...(field.variants ?? [])];
}
