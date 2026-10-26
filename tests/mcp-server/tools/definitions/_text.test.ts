/**
 * @fileoverview Tests for the render-time helpers that keep depositor- and
 * caller-supplied text inside its Markdown slot.
 * @module tests/mcp-server/tools/definitions/_text.test
 */

import { describe, expect, it } from 'vitest';
import {
  blockquote,
  descriptionQuote,
  fenced,
  flattenInline,
  num,
  orNA,
  tableCell,
  urlLink,
} from '@/mcp-server/tools/definitions/_text.js';
import { OTHER_LINE_BREAKS } from '../../../helpers/harness.js';
import { commonmark, markdownText } from '../../../helpers/markdown.js';

describe('literal Markdown roundtrips', () => {
  it.each([['LF', '\n'], ['CR', '\r'], ['CRLF', '\r\n'], ...OTHER_LINE_BREAKS] as const)(
    'keeps malformed URL text in one inline slot across %s',
    (_name, sep) => {
      const rendered = urlLink(`https://x.test/${sep}# heading`);
      expect(rendered).not.toContain(sep);
      expect(markdownText(rendered)).toBe('https://x.test/ # heading');
    },
  );
  it('keeps a URL destination byte-identical and its label literal', () => {
    const value = 'https://x.test/a(b)?q=&lt;i&gt;';
    const inline = commonmark.parse(urlLink(value), {}).find((token) => token.type === 'inline');
    expect(inline?.children?.find((token) => token.type === 'link_open')?.attrGet('href')).toBe(
      value,
    );
    expect(markdownText(urlLink(value))).toBe(value);
  });
  it('frames preformatted text and table rows without losing whitespace', () => {
    const tokens = commonmark.parse(
      descriptionQuote(
        '<pre>  x\n\ty  \n</pre><table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>',
      ),
      {},
    );
    expect(tokens.filter((token) => token.type === 'fence').map((token) => token.content)).toEqual([
      '  x\n\ty  \n',
      'A\tB\t\n1\t2\t\n',
    ]);
  });

  it('bounds literal rendering thread CPU across 64-fold text growth', () => {
    for (const [unit, escapedUnit] of [
      ['[[[', '\\[\\[\\['],
      ['[a[', '\\[a\\['],
      ['<[<', '<\\[<'],
      ['[a\n', '\\[a\n'],
      ['<a\n', '\\<a\n'],
    ] as const) {
      const inlineSamples: number[] = [];
      const quoteSamples: number[] = [];
      for (const size of [5000, 20_000, 80_000, 320_000]) {
        const repeats = Math.floor(size / unit.length);
        const value = `${unit.repeat(repeats)}\n`;
        const escaped = escapedUnit.repeat(repeats).trim();
        let inline = '';
        let quoted = '';
        let inlineMicros = 0;
        let quoteMicros = 0;
        for (let repeat = 0; repeat < 5; repeat++) {
          const inlineStart = process.threadCpuUsage();
          inline = flattenInline(value);
          const inlineCpu = process.threadCpuUsage(inlineStart);
          const inlineSample = inlineCpu.user + inlineCpu.system;
          expect(inlineSample).toBeLessThan(500_000);
          inlineMicros += inlineSample;
          const quoteStart = process.threadCpuUsage();
          quoted = blockquote(value);
          const quoteCpu = process.threadCpuUsage(quoteStart);
          const quoteSample = quoteCpu.user + quoteCpu.system;
          expect(quoteSample).toBeLessThan(500_000);
          quoteMicros += quoteSample;
        }
        inlineSamples.push(Math.max(1, inlineMicros));
        quoteSamples.push(Math.max(1, quoteMicros));
        expect(inline).toBe(escaped.replace(/\n/g, ' '));
        expect(quoted).toBe(`> ${escaped.replace(/\n/g, '\\\n> ')}`);
      }
      expect(inlineSamples[3]! / inlineSamples[0]!).toBeLessThan(256);
      expect(quoteSamples[3]! / quoteSamples[0]!).toBeLessThan(256);
      console.info(
        'render CPU totals over five calls',
        process.versions.bun ? 'Bun' : 'Node',
        unit,
        { inlineSamples, quoteSamples },
      );
    }
  });
  it.each([
    'Obs_*StationName*',
    '`code` [x](https://x.test)',
    '&lt;i&gt;',
    '> quote',
    '[id]: https://x.test',
    '# heading',
    'closing ##',
  ])('keeps %s literal in inline and quote slots', (value) => {
    expect(markdownText(`# ${flattenInline(value)}`)).toBe(value);
    expect(markdownText(blockquote(value))).toBe(value);
    const tokens = commonmark.parse(blockquote(value), {});
    expect(tokens.filter((token) => token.type === 'blockquote_open')).toHaveLength(1);
    expect(
      tokens
        .flatMap((token) => token.children ?? [])
        .filter((token) =>
          ['em_open', 'code_inline', 'link_open', 'html_inline'].includes(token.type),
        ),
    ).toHaveLength(0);
  });
});

describe('literal text', () => {
  it('escapes scientific comparisons and literal tags without decoding nested entities', () => {
    expect(markdownText(flattenInline('T < 5 and p > 0; <i>x</i>; &lt;i&gt; &amp;lt;'))).toBe(
      'T < 5 and p > 0; <i>x</i>; &lt;i&gt; &amp;lt;',
    );
  });
});

describe('flattenInline', () => {
  it('collapses every kind of line break to one space and trims', () => {
    expect(flattenInline('  Title\r\n# Injected heading\n\nmore x y ')).toBe(
      'Title # Injected heading more x y',
    );
  });

  it.each(OTHER_LINE_BREAKS)('flattens %s like LF, a run of them to one space', (_name, sep) => {
    expect(flattenInline(`a${sep}## x${sep}${sep}- y${sep}`)).toBe('a ## x - y');
  });
});

describe('tableCell', () => {
  it('flattens and escapes pipes so a value cannot open a new column', () => {
    expect(tableCell('a | b\n| c')).toBe('a \\| b \\| c');
  });

  it('escapes backslashes so one before a pipe cannot cancel the pipe escape', () => {
    expect(tableCell('a\\| b \\')).toBe('a\\\\\\| b \\\\');
  });

  it.each(OTHER_LINE_BREAKS)('keeps a row on one line across %s', (_name, sep) => {
    expect(tableCell(`a${sep}| b |`)).toBe('a \\| b \\|');
  });
});

describe('blockquote', () => {
  it('characterizes hard breaks, whitespace-only blank lines, and literal trailing slashes', () => {
    expect(blockquote('a\\\nb\n \t\n\n c\n\\')).toBe('> a\\\\\\\n> b\n>\n>\n> &#32;c\\\n> \\\\');
  });
  it('prefixes every line, normalizing CRLF and marking blank lines', () => {
    expect(markdownText(blockquote('\nFirst line\r\n\r\n# not a heading\rlast\n'))).toBe(
      'First line\n# not a heading\nlast',
    );
  });

  it.each(OTHER_LINE_BREAKS)(
    'starts a quoted line at %s, marking a doubled one blank',
    (_name, sep) => {
      expect(markdownText(blockquote(`${sep}a${sep}## x${sep}${sep}- y${sep}`))).toBe(
        'a\n## x\n- y',
      );
    },
  );
});

describe('fenced', () => {
  it('uses a three-backtick fence for a payload without backticks', () => {
    expect(fenced('{"a":1}\n\n', 'json')).toBe('```json\n{"a":1}\n\n```');
  });

  it('outruns the longest backtick run in the payload', () => {
    const payload = 'x ``` y ```` z';
    const block = fenced(payload);
    expect(block).toBe(`\`\`\`\`\`\n${payload}\n\`\`\`\`\``);
    expect(block.split('\n')[0]).toHaveLength(5);
  });

  it('trims trailing whitespace in linear time when a long whitespace run sits mid-payload', () => {
    const payload = `${' '.repeat(100_000)}x`;
    const start = performance.now();
    expect(fenced(`${payload} \n\t`)).toBe(`\`\`\`\n${payload} \n\t\n\`\`\``);
    expect(performance.now() - start).toBeLessThan(250);
  });

  it('sizes the fence over 200,000 backtick runs without exhausting the stack', () => {
    const payload = `${'`a'.repeat(200_000)}\`\`\`\`b`;
    expect(fenced(payload)).toBe(`\`\`\`\`\`\n${payload}\n\`\`\`\`\``);
  });
});

describe('orNA and num', () => {
  it('marks an absent value explicitly and flattens a present one', () => {
    expect(orNA(undefined)).toBe('Not available');
    expect(orNA(0)).toBe('0');
    expect(orNA('')).toBe('');
    expect(orNA('two\nlines')).toBe('two lines');
  });

  it('groups thousands', () => {
    expect(num(135809087)).toBe('135,809,087');
    expect(num(0)).toBe('0');
  });
});
