/**
 * @fileoverview JATS loss detection and scanner growth bounds.
 * @module tests/services/datacite/jats-notice.test
 */
import { describe, expect, it } from 'vitest';
import { jatsNotice } from '@/services/datacite/jats-notice.js';

describe('jatsNotice', () => {
  it.each([
    '',
    'plain text',
    '<name>Smith</name>',
    '<year>10</year>',
    '<year iso-8601-date="2026">2026</year>',
    '<!-- <name/> <year iso-8601-date="2026">10</year> -->',
    '<![CDATA[<name/>]]>',
    '<name><![CDATA[Smith]]></name>',
    '<year note="iso-8601-date=\'2026\'">10</year>',
  ])('keeps no-signal document %j quiet', (value) => {
    expect(jatsNotice(value)).toBeUndefined();
  });
  it('counts nested empty name elements without treating empty child tags as names', () => {
    expect(
      jatsNotice(
        '<person-group><name/><name> \r\n </name><name><surname/></name><name><surname>Smith</surname></name></person-group>',
      ),
    ).toContain('3 empty <name> elements');
  });
  it('reports a year independently with either quote and a full ISO date', () => {
    expect(jatsNotice('<year iso-8601-date="2026"/>')).toContain(
      'non-year text inconsistent with iso-8601-date year 2026',
    );
    expect(jatsNotice("<year iso-8601-date='2026-03-03'>10</year>")).toContain(
      'year "10" differs from iso-8601-date year 2026',
    );
    expect(jatsNotice('<year other="x > y" iso-8601-date="2025">2024</year>')).toContain(
      'year "2024" differs from iso-8601-date year 2025',
    );
  });
  it('summarizes repeated inconsistent years without repeating every value', () => {
    const result = jatsNotice('<year iso-8601-date="2026">10</year>'.repeat(1000));
    expect(result).toContain('1000 inconsistent year elements');
    expect(result?.match(/year "10"/g)).toHaveLength(1);
  });
  it('bounds scanner thread CPU across 64-fold growth', () => {
    const shapes = [
      (size: number) => '<name'.repeat(Math.floor(size / 5)),
      (size: number) =>
        `${'<name>'.repeat(Math.floor(size / 13))}Smith${'</name>'.repeat(Math.floor(size / 13))}`,
      (size: number) => `<year iso-8601-date="2026">${'2'.repeat(size)}\n</year>`,
      (size: number) => `${'a\r\n<name>Smith</name>\r\n'.repeat(Math.floor(size / 24))}\n`,
      (size: number) => `<!--${'<name/>'.repeat(Math.floor(size / 7))}-->`,
      (size: number) => '<name/>'.repeat(Math.floor(size / 7)),
    ];
    for (const [index, shape] of shapes.entries()) {
      const samples: number[] = [];
      for (const size of [5000, 20_000, 80_000, 320_000]) {
        const value = shape(size);
        const start = process.threadCpuUsage();
        const results: Array<string | undefined> = [];
        for (let repeat = 0; repeat < 5; repeat++) results.push(jatsNotice(value));
        const cpu = process.threadCpuUsage(start);
        const micros = cpu.user + cpu.system;
        expect(micros).toBeLessThan(500_000);
        for (const result of results) {
          if (index === 2) {
            expect(result).toContain('non-year text inconsistent with iso-8601-date year 2026');
            expect(result).not.toContain('2'.repeat(size));
          } else if (index === 5)
            expect(result).toContain(`${Math.floor(size / 7)} empty <name> elements`);
          else expect(result).toBeUndefined();
        }
        samples.push(Math.max(1, micros));
      }
      expect(samples[3]! / samples[0]!).toBeLessThan(256);
      console.info('JATS scanner CPU', process.versions.bun ? 'Bun' : 'Node', index, samples);
    }
  });
});
