/**
 * @fileoverview Process-global LRU cache with per-entry TTLs, an entry cap, a
 * total-bytes budget, and an injectable clock. Shared by every upstream client
 * so one public answer is fetched once per TTL for every caller of a deployment.
 * @module services/http/ttl-cache
 */

/** Construction options for {@link TtlCache}. */
export interface TtlCacheOptions {
  /** Total bytes, as each `set` reports them, kept before the least recently used is evicted. Default 50,000,000. */
  maxBytes?: number;
  /** Entries kept before the least recently used is evicted. Default 500. */
  maxEntries?: number;
  /** Clock in epoch milliseconds. Default `Date.now`. */
  now?: () => number;
}

interface Entry<V> {
  bytes: number;
  expiresAt: number;
  value: V;
}

/** A least-recently-used map whose entries expire after their own TTL. */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private totalBytes = 0;

  constructor(options: TtlCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? 50_000_000;
    this.maxEntries = options.maxEntries ?? 500;
    this.now = options.now ?? Date.now;
  }

  /** The live value for `key`, refreshed as most recently used; `undefined` when absent or expired. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expiresAt <= this.now()) {
      this.remove(key);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /**
   * Stores `value` for `ttlMs`, evicting least recently used entries past either
   * cap. `bytes` is the value's size against the byte budget; a value larger than
   * the whole budget is not stored.
   */
  set(key: string, value: V, ttlMs: number, bytes = 0): void {
    this.remove(key);
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes, expiresAt: this.now() + ttlMs });
    this.totalBytes += bytes;
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }
}
