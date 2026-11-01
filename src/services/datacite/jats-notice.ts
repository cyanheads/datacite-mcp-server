/**
 * @fileoverview Detects empty names and inconsistent years in negotiated JATS without changing it.
 * @module services/datacite/jats-notice
 */

type Element = {
  name: string;
  textStart: number;
  visibleStart: number;
  hasChildren: boolean;
  isoYear?: string;
};

/** Reads quoted attributes in order so an attribute value cannot impersonate another attribute. */
function isoYearOf(token: string, position: number): string | undefined {
  while (position < token.length) {
    while (/\s/.test(token[position] ?? '')) position++;
    const start = position;
    while (position < token.length && !/[\s=/]/.test(token[position] ?? '')) position++;
    const name = token.slice(start, position);
    while (/\s/.test(token[position] ?? '')) position++;
    if (token[position] !== '=') return undefined;
    position++;
    while (/\s/.test(token[position] ?? '')) position++;
    const quote = token[position];
    if (quote !== '"' && quote !== "'") return undefined;
    const end = token.indexOf(quote, position + 1);
    if (end === -1) return undefined;
    if (name === 'iso-8601-date')
      return /^(\d{4})(?:-|$)/.exec(token.slice(position + 1, end))?.[1];
    position = end + 1;
  }
  return undefined;
}

/** Inspects one upstream document; absence of either defect produces no notice. */
export function jatsNotice(document: string): string | undefined {
  const stack: Element[] = [];
  const text: string[] = [];
  const years: Array<{ start: number; end: number; iso: string }> = [];
  let textLength = 0;
  let visibleLength = 0;
  let emptyNames = 0;
  let position = 0;
  const append = (value: string) => {
    text.push(value);
    textLength += value.length;
    visibleLength += value.replace(/\s/g, '').length;
  };
  const close = (element: Element) => {
    if (element.name === 'name') {
      if (element.visibleStart === visibleLength) emptyNames++;
    } else if (element.name === 'year' && element.isoYear && !element.hasChildren) {
      years.push({ start: element.textStart, end: textLength, iso: element.isoYear });
    }
  };
  /** Each character is scanned once, including malformed repeated openers and quoted attributes. */
  while (position < document.length) {
    const opening = document.indexOf('<', position);
    if (opening === -1) {
      append(document.slice(position));
      break;
    }
    append(document.slice(position, opening));
    if (document.startsWith('<!--', opening) || document.startsWith('<![CDATA[', opening)) {
      const cdata = document.startsWith('<![CDATA[', opening);
      const ending = document.indexOf(cdata ? ']]>' : '-->', opening + (cdata ? 9 : 4));
      if (ending === -1) break;
      if (cdata) append(document.slice(opening + 9, ending));
      position = ending + 3;
      continue;
    }
    let quote = '';
    let end = opening + 1;
    for (; end < document.length; end++) {
      const character = document[end];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") quote = character;
      else if (character === '>' || character === '<') break;
    }
    if (document[end] !== '>') {
      position = end;
      continue;
    }
    const token = document.slice(opening + 1, end);
    position = end + 1;
    const match = /^(\/?)([A-Za-z_][\w.:-]*)(?=[\s/]|$)/.exec(token);
    const name = match?.[2];
    if (!match || !name) continue;
    if (match[1]) {
      const element = stack.pop();
      if (element?.name === name) close(element);
      continue;
    }
    const parent = stack.at(-1);
    if (parent) parent.hasChildren = true;
    const iso = name === 'year' ? isoYearOf(token, match[0].length) : undefined;
    const element: Element = {
      name,
      textStart: textLength,
      visibleStart: visibleLength,
      hasChildren: false,
      ...(iso && { isoYear: iso }),
    };
    if (token.endsWith('/')) close(element);
    else stack.push(element);
  }
  const visible = text.join('');
  const defects: string[] = [];
  let inconsistentYears = 0;
  let yearExample: string | undefined;
  for (const entry of years) {
    const value = visible.slice(entry.start, entry.end).trim();
    if (value !== entry.iso) {
      inconsistentYears++;
      yearExample ??= /^\d{1,4}$/.test(value)
        ? `year ${JSON.stringify(value)} differs from iso-8601-date year ${entry.iso}`
        : `a year element contains non-year text inconsistent with iso-8601-date year ${entry.iso}`;
    }
  }
  if (yearExample)
    defects.push(
      inconsistentYears === 1
        ? yearExample
        : `${inconsistentYears} inconsistent year elements (${yearExample})`,
    );
  if (emptyNames)
    defects.unshift(`${emptyNames} empty <name> element${emptyNames === 1 ? '' : 's'}`);
  if (!defects.length) return undefined;
  return `DataCite's JATS rendering contains ${defects.join('; ')}. The upstream document is unchanged; use csl_json, bibtex, ris, or datacite_json for another export.`;
}
