/**
 * @fileoverview CommonMark parsing for literal-value rendering assertions.
 * @module tests/helpers/markdown
 */
import MarkdownIt from 'markdown-it';

export const commonmark = new MarkdownIt('commonmark');

/** Visible inline leaves, including authored hard and soft line breaks. */
export function markdownText(markdown: string): string {
  return commonmark
    .parse(markdown, {})
    .flatMap((token) =>
      token.type === 'fence'
        ? [token.content]
        : token.type === 'inline'
          ? [
              (token.children ?? [])
                .map((child) =>
                  child.type === 'hardbreak' || child.type === 'softbreak'
                    ? '\n'
                    : child.type === 'text' || child.type === 'code_inline'
                      ? child.content
                      : '',
                )
                .join(''),
            ]
          : [],
    )
    .join('\n');
}
