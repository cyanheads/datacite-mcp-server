/**
 * @fileoverview Process-global LRU cache with per-entry TTLs and an injectable
 * clock. Shared by every upstream client so one public answer is fetched once per
 * TTL for every caller of a deployment.
 * @module services/http/ttl-cache
 */

/** Construction options for {@link TtlCache}. */
export interface TtlCacheOptions {
  /** Entries kept before the least recently used is evicted. Default 500. */
  maxEntries?: number;
  /** Clock in epoch milliseconds. Default `Date.now`. */
  now?: () => number;
}

interface Entry<V> {
  expiresAt: number;
  value: V;
}

/** A least-recently-used map whose entries expire after their own TTL. */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: TtlCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 500;
    this.now = options.now ?? Date.now;
  }

  /** The live value for `key`, refreshed as most recently used; `undefined` when absent or expired. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Stores `value` for `ttlMs`, evicting the least recently used entry past capacity. */
  set(key: string, value: V, ttlMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
