export class LookupCache<T> {
  private readonly values = new Map<string, T>();

  remember(id: string, value: T): T {
    if (id) this.values.set(id, value);
    return value;
  }

  getOrLoad(id: string, load: (id: string) => T): T {
    const existing = this.values.get(id);
    if (existing !== undefined) return existing;
    return this.remember(id, load(id));
  }
}
