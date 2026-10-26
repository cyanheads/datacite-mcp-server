/**
 * @fileoverview Tests for turning a formatted citation's HTML into plain text:
 * tags stripped, entities decoded, whitespace collapsed.
 * @module tests/services/datacite/html-text.test
 */

import { describe, expect, it } from 'vitest';
import { htmlToDescriptionBlocks, htmlToText } from '@/services/datacite/html-text.js';
import { fixtureText } from '../../helpers/fixtures.js';

describe('htmlToText', () => {
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
  });
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
    const start = performance.now();
    expect(htmlToText(run)).toBe(run);
    expect(performance.now() - start).toBeLessThan(250);
  });

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
  }, 10_000);
});
