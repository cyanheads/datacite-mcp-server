/**
 * @fileoverview Tests for the render-time helpers that keep depositor- and
 * caller-supplied text inside its Markdown slot.
 * @module tests/mcp-server/tools/definitions/_text.test
 */

import { describe, expect, it } from 'vitest';
import {
  blockquote,
  fenced,
  flattenInline,
  num,
  orNA,
  tableCell,
} from '@/mcp-server/tools/definitions/_text.js';

describe('flattenInline', () => {
  it('collapses every kind of line break to one space and trims', () => {
    expect(flattenInline('  Title\r\n# Injected heading\n\nmore x y ')).toBe(
      'Title # Injected heading more x y',
    );
  });
});

describe('tableCell', () => {
  it('flattens and escapes pipes so a value cannot open a new column', () => {
    expect(tableCell('a | b\n| c')).toBe('a \\| b \\| c');
  });
});

describe('blockquote', () => {
  it('prefixes every line, normalizing CRLF and marking blank lines', () => {
    expect(blockquote('\nFirst line\r\n\r\n# not a heading\rlast\n')).toBe(
      '> First line\n>\n> # not a heading\n> last',
    );
  });
});

describe('fenced', () => {
  it('uses a three-backtick fence for a payload without backticks', () => {
    expect(fenced('{"a":1}\n\n', 'json')).toBe('```json\n{"a":1}\n```');
  });

  it('outruns the longest backtick run in the payload', () => {
    const payload = 'x ``` y ```` z';
    const block = fenced(payload);
    expect(block).toBe(`\`\`\`\`\`\n${payload}\n\`\`\`\`\``);
    expect(block.split('\n')[0]).toHaveLength(5);
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
