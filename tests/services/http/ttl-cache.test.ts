/**
 * @fileoverview Tests for the process-global LRU + TTL cache: reads, expiry at
 * the TTL boundary, recency refresh on read and write, and eviction past capacity.
 * @module tests/services/http/ttl-cache.test
 */

import { describe, expect, it } from 'vitest';
import { TtlCache } from '@/services/http/ttl-cache.js';
import { manualClock } from '../../helpers/harness.js';

describe('TtlCache', () => {
  it('returns a stored value and undefined for an unknown key', () => {
    const cache = new TtlCache<string>({ now: manualClock().now });
    cache.set('a', 'alpha', 1000);
    expect(cache.get('a')).toBe('alpha');
    expect(cache.get('b')).toBeUndefined();
  });

  it('serves an entry until its TTL elapses, then drops it', () => {
    const clock = manualClock();
    const cache = new TtlCache<string>({ now: clock.now });
    cache.set('a', 'alpha', 1000);
    clock.advance(999);
    expect(cache.get('a')).toBe('alpha');
    clock.advance(1);
    expect(cache.get('a')).toBeUndefined();
    clock.advance(-1);
    expect(cache.get('a')).toBeUndefined();
  });

  it('gives each entry its own TTL', () => {
    const clock = manualClock();
    const cache = new TtlCache<string>({ now: clock.now });
    cache.set('short', 's', 100);
    cache.set('long', 'l', 10_000);
    clock.advance(500);
    expect(cache.get('short')).toBeUndefined();
    expect(cache.get('long')).toBe('l');
  });

  it('restarts the TTL when a key is written again', () => {
    const clock = manualClock();
    const cache = new TtlCache<string>({ now: clock.now });
    cache.set('a', 'first', 1000);
    clock.advance(900);
    cache.set('a', 'second', 1000);
    clock.advance(900);
    expect(cache.get('a')).toBe('second');
  });

  it('evicts the least recently used entry past capacity', () => {
    const cache = new TtlCache<number>({ maxEntries: 2, now: manualClock().now });
    cache.set('a', 1, 1000);
    cache.set('b', 2, 1000);
    cache.set('c', 3, 1000);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('refreshes recency on read, so a read entry outlives an unread one', () => {
    const cache = new TtlCache<number>({ maxEntries: 2, now: manualClock().now });
    cache.set('a', 1, 1000);
    cache.set('b', 2, 1000);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3, 1000);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('refreshes recency on overwrite', () => {
    const cache = new TtlCache<number>({ maxEntries: 2, now: manualClock().now });
    cache.set('a', 1, 1000);
    cache.set('b', 2, 1000);
    cache.set('a', 10, 1000);
    cache.set('c', 3, 1000);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(10);
  });

  it('defaults to 500 entries', () => {
    const cache = new TtlCache<number>({ now: manualClock().now });
    for (let i = 0; i <= 500; i++) cache.set(`k${i}`, i, 1000);
    expect(cache.get('k0')).toBeUndefined();
    expect(cache.get('k1')).toBe(1);
    expect(cache.get('k500')).toBe(500);
  });
});
