/**
 * @fileoverview Punctuation- and case-insensitive lookup used to canonicalize
 * enum-ish inputs: `JournalArticle`, `journal-article`, `journal_article`, and
 * `Journal Article` all resolve to one canonical id.
 * @module services/reference/lookup
 */

/** Lowercase with every non-alphanumeric character removed. */
const canonicalKey = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Builds a resolver from canonical ids and their accepted spellings. A spelling
 * whose key names more than one canonical id is a table bug, so it throws at
 * module load rather than resolving ambiguously.
 */
export function buildResolver<T extends string>(
  entries: ReadonlyArray<{ aliases?: readonly string[]; id: T }>,
): (value: string) => T | undefined {
  const table = new Map<string, T>();
  for (const { id, aliases = [] } of entries) {
    for (const spelling of [id, ...aliases]) {
      const key = canonicalKey(spelling);
      const existing = table.get(key);
      if (existing !== undefined && existing !== id) {
        throw new Error(`Lookup key "${key}" maps to both "${existing}" and "${id}".`);
      }
      table.set(key, id);
    }
  }
  return (value) => table.get(canonicalKey(value));
}
