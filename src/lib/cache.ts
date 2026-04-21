// Tiny LRU. Good enough for a single-instance dev server; swap for Redis
// if we ever run more than one replica.
export class LRU<K, V> {
  private map = new Map<K, V>();
  constructor(private max: number) {}

  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v === undefined) return undefined;
    // Re-insert to mark as most-recently-used.
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }

  set(k: K, v: V): void {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
