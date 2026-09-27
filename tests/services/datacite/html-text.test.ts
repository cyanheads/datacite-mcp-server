/**
 * @fileoverview Tests for turning a formatted citation's HTML into plain text:
 * tags stripped, entities decoded, whitespace collapsed.
 * @module tests/services/datacite/html-text.test
 */

import { describe, expect, it } from 'vitest';
import { htmlToText } from '@/services/datacite/html-text.js';
import { fixtureText } from '../../helpers/fixtures.js';

describe('htmlToText', () => {
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
});
