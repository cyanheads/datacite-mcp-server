/**
 * @fileoverview Tests for turning a formatted citation's HTML into plain text:
 * tags stripped, entities decoded, whitespace collapsed. Also locating the tag or
 * character reference a slice boundary falls inside.
 * @module tests/services/datacite/html-text.test
 */

import { describe, expect, it } from 'vitest';
import {
  htmlToDescriptionBlocks,
  htmlToText,
  markupAround,
} from '@/services/datacite/html-text.js';
import { fixtureText } from '../../helpers/fixtures.js';

describe('htmlToText', () => {
  it('decodes semicolon-terminated WHATWG names exactly once with case-sensitive lookup', () => {
    const value =
      '&beta;&alpha;&deg;&plusmn;&eacute;&frac12;&NotEqualTilde;&Afr; &AMP; &Beta; &BETA; &amp;beta; &bogus; &constructor; &beta';
    const expected = 'βα°±é½≂̸𝔄 & Β &BETA; &beta; &bogus; &constructor; &beta';
    expect(htmlToText(value)).toBe(expected);
    expect(htmlToDescriptionBlocks(`<p>${value}</p>`)).toEqual([{ kind: 'text', text: expected }]);
  });
  it('characterizes numeric references and literal unknown names', () => {
    expect(htmlToText('&#128; &#xD800; &Beta &constructor; &AMP;')).toBe(
      '\u0080 \ud800 &Beta &constructor; &',
    );
  });
  it('keeps description paragraph, nested list, pre and table boundaries', () => {
    expect(
      htmlToDescriptionBlocks(
        '<p>First *literal*</p><p>Second &amp;lt;i&amp;gt; T < 5 and p > 0</p>',
      ),
    ).toEqual([{ kind: 'text', text: 'First *literal*\n\nSecond &lt;i&gt; T < 5 and p > 0' }]);
    expect(htmlToDescriptionBlocks('One\n\nTwo\nThree')).toEqual([
      { kind: 'text', text: 'One\n\nTwo\nThree' },
    ]);
    expect(
      htmlToDescriptionBlocks('<ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul>')[0]?.text,
    ).toContain('  • Nested');
    expect(
      htmlToDescriptionBlocks(
        '<pre>  x\n\ty  \n</pre><table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>',
      ),
    ).toEqual([
      { kind: 'pre', text: '  x\n\ty  \n' },
      { kind: 'pre', text: 'A\tB\t\n1\t2\t\n' },
    ]);
    expect(htmlToDescriptionBlocks('&lt;i&gt;x&lt;/i&gt;')).toEqual([
      { kind: 'text', text: '<i>x</i>' },
    ]);
  });

  it('bounds description conversion thread CPU across 64-fold text growth', () => {
    for (const unit of ['<em', '[[[', '<[<[', '<em\n', '[a\n']) {
      const samples: number[] = [];
      for (const size of [5000, 20_000, 80_000, 320_000]) {
        const value = `${unit.repeat(Math.floor(size / unit.length))}\n`;
        const start = process.threadCpuUsage();
        for (let repeat = 0; repeat < 10; repeat++)
          expect(htmlToDescriptionBlocks(value)).toEqual([{ kind: 'text', text: value.trim() }]);
        const cpu = process.threadCpuUsage(start);
        const micros = cpu.user + cpu.system;
        expect(micros).toBeLessThan(500_000);
        samples.push(Math.max(1, micros));
      }
      expect(samples[3]! / samples[0]!).toBeLessThan(256);
      console.info('description CPU', process.versions.bun ? 'Bun' : 'Node', unit, samples);
    }
  }, 0);
  it('characterizes nested escape decoding as exactly one pass', () => {
    expect(htmlToText('&amp;lt;i&amp;gt;')).toBe('&lt;i&gt;');
    expect(htmlToText('<i>&lt;b&gt;x&lt;/b&gt;</i>')).toBe('<b>x</b>');
  });
  it('preserves scientific comparisons and separates recognized blocks', () => {
    expect(htmlToText('T < 5 and p > 0')).toBe('T < 5 and p > 0');
    expect(htmlToText('<p>A <em>B</em></p><div>C<br>D</div>')).toBe('A B C D');
    expect(htmlToText('&lt;i&gt;<b>x</b>&lt;/i&gt;')).toBe('<i>x</i>');
  });
  it('strips the markup of a recorded APA rendering and decodes its entities', () => {
    const html = fixtureText('datacite/citations/dryad-8515-default.html');
    const plain = htmlToText(html);
    expect(html).toMatch(/<i>|&amp;/);
    expect(plain).toBe(
      'Ollomo, B., Durand, P., Prugnolle, F., Douzery, E. J. P., Arnathau, C., Nkoghe, D., Leroy, E., & Renaud, F. (2011). Data from: A new malaria agent in African hominids. (Version 1) [Dataset]. Dryad. https://doi.org/10.5061/DRYAD.8515',
    );
  });

  it('drops tags, including small-caps spans', () => {
    expect(htmlToText('<i>Title</i> by <span style="font-variant: small-caps">Smith</span>')).toBe(
      'Title by Smith',
    );
  });

  it('decodes named, decimal, and hexadecimal entities', () => {
    expect(htmlToText('A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(
      'A & B <c> "d" \'e\'',
    );
    expect(htmlToText('&ndash;&mdash;&lsquo;&rsquo;&ldquo;&rdquo;&hellip;')).toBe('–—‘’“”…');
    expect(htmlToText('&#233;&#xE9;&#XE9;&#x1F600;')).toBe('ééé\u{1F600}');
  });

  it('keeps entity-looking text it cannot decode', () => {
    expect(htmlToText('&bogus; &#0; &#x110000; &constructor;')).toBe(
      '&bogus; &#0; &#x110000; &constructor;',
    );
  });

  it('decodes after stripping, so escaped markup survives as text', () => {
    expect(htmlToText('&lt;i&gt;not a tag&lt;/i&gt;')).toBe('<i>not a tag</i>');
  });

  it('collapses whitespace, non-breaking and thin spaces included, and trims', () => {
    expect(htmlToText('  a\n\n b&nbsp;c&thinsp;d\t ')).toBe('a b c d');
  });

  it('keeps a long run of unclosed angle brackets, in linear time', () => {
    const run = `${'<'.repeat(100_000)}x`;
    const start = process.threadCpuUsage();
    expect(htmlToText(run)).toBe(run);
    const cpu = process.threadCpuUsage(start);
    expect(cpu.user + cpu.system).toBeLessThan(250_000);
  }, 0);

  it('keeps a stray < as text rather than dropping everything up to the next tag', () => {
    expect(htmlToText('T < 5 K, <i>in situ</i>')).toBe('T < 5 K, in situ');
  });

  it('bounds HTML conversion thread CPU across 64-fold text growth', () => {
    const shapes = [
      (n: number) => {
        const value = '<em'.repeat(Math.floor(n / 3));
        return { value, expected: value };
      },
      (n: number) => {
        const value = '&amp'.repeat(Math.floor(n / 4));
        return { value, expected: value };
      },
      (n: number) => ({
        value: `${'<i>'.repeat(Math.floor(n / 7))}x${'</i>'.repeat(Math.floor(n / 7))}`,
        expected: 'x',
      }),
      (n: number) => ({
        value: `T < ${'a'.repeat(n)} > 0\n`,
        expected: `T < ${'a'.repeat(n)} > 0`,
      }),
      (n: number) => ({
        value: `T < ${'a\n'.repeat(Math.floor(n / 2))} > 0`,
        expected: `T < ${'a '.repeat(Math.floor(n / 2))}> 0`,
      }),
      (n: number) => {
        const value = `<${'a'.repeat(n)}>`;
        return { value, expected: value };
      },
    ];
    for (const shape of shapes) {
      const samples: number[] = [];
      for (const size of [625, 1250, 2500, 5000, 10_000, 20_000, 40_000, 80_000]) {
        const { value, expected } = shape(size);
        const converted: string[] = [];
        const start = process.threadCpuUsage();
        for (let repeat = 0; repeat < 30; repeat++) converted.push(htmlToText(value));
        const cpu = process.threadCpuUsage(start);
        const micros = cpu.user + cpu.system;
        expect(micros).toBeLessThan(500_000);
        expect(converted).toEqual(Array<string>(30).fill(expected));
        samples.push(Math.max(1, micros));
      }
      // 625 → 40,000 spans 64× without crossing Bun's large-regex mode switch.
      expect(samples[6]! / samples[0]!).toBeLessThan(256);
    }
  }, 0);
});

describe('markupAround', () => {
  it.each([
    ['inside an opening tag', 'ab<i>cd', 3, { start: 2, end: 5 }],
    ['just before a tag closes', 'ab<i>cd', 4, { start: 2, end: 5 }],
    ['inside a closing tag', 'x</i>', 2, { start: 1, end: 5 }],
    ['at the < that opens a tag', 'ab<i>cd', 2, undefined],
    ['just after the > that closes a tag', 'ab<i>cd', 5, undefined],
    ['after a stray < that a later < leaves open', 'T < 5 <i>', 3, undefined],
    ['after a < that never closes', 'a <b', 3, undefined],
    ['inside a named reference', 'a&amp;b', 3, { start: 1, end: 6 }],
    ['inside a decimal reference', 'a&#38;b', 2, { start: 1, end: 6 }],
    ['inside a hex reference, any case', 'a&#X2F;b', 4, { start: 1, end: 7 }],
    ['just before a named reference closes', 'a&amp;b', 5, { start: 1, end: 6 }],
    ['just before a decimal reference closes', 'a&#38;b', 5, { start: 1, end: 6 }],
    ['just after a reference', 'a&amp;b', 6, undefined],
    ['after an & that opens no reference', 'a & b', 2, undefined],
    ['inside an unterminated reference', 'a&amp b', 3, undefined],
    ['inside a reference inside a tag', '<a t="&amp;">', 8, { start: 0, end: 13 }],
    ['between two references', '&amp;&lt;', 5, undefined],
  ])('%s', (_name, html, position, around) => {
    expect(markupAround(html, position)).toEqual(around);
  });

  /** The least thread CPU, in µs, of several timings of 20 calls. */
  const leastCpu = (call: () => unknown): number => {
    let least = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 5; round++) {
      const start = process.threadCpuUsage();
      for (let repeat = 0; repeat < 20; repeat++) call();
      const cpu = process.threadCpuUsage(start);
      least = Math.min(least, cpu.user + cpu.system);
    }
    return Math.max(1, least);
  };

  it('bounds the scan around a boundary to linear thread CPU across 64-fold text growth', () => {
    const shapes: Array<(n: number) => { html: string; position: number; around?: object }> = [
      (n) => ({ html: 'a'.repeat(n), position: n >> 1 }),
      (n) => ({ html: `<${'a'.repeat(n)}`, position: n >> 1 }),
      (n) => ({ html: `${'a'.repeat(n)}>`, position: n >> 1 }),
      (n) => ({ html: `&${'a'.repeat(n)}`, position: n >> 1 }),
      (n) => ({ html: `<${'a'.repeat(n)}>`, position: n >> 1, around: { start: 0, end: n + 2 } }),
      (n) => ({ html: `&#${'7'.repeat(n)};`, position: n >> 1, around: { start: 0, end: n + 3 } }),
      (n) => ({ html: `${'§1 x'.repeat(n >> 2)}\ny`, position: n >> 1 }),
      (n) => ({ html: '  \r\n'.repeat(n >> 2), position: n >> 1 }),
    ];
    for (const shape of shapes) {
      for (let size = 5_000; size <= 320_000; size *= 2) {
        const large = shape(size);
        expect(markupAround(large.html, large.position)).toEqual(large.around);
        expect(leastCpu(() => markupAround(large.html, large.position))).toBeLessThan(250_000);
      }
      const small = shape(5_000);
      const large = shape(320_000);
      let growth = Number.POSITIVE_INFINITY;
      for (let pair = 0; pair < 3; pair++) {
        const baseline = leastCpu(() => markupAround(small.html, small.position));
        growth = Math.min(
          growth,
          leastCpu(() => markupAround(large.html, large.position)) / baseline,
        );
      }
      // Linear growth from 5k to 320k reads about 64; quadratic, about 4,096.
      expect(growth).toBeLessThan(256);
    }
  }, 0);
});
