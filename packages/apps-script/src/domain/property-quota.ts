/** Apps Script documents a 9 KB limit per property value. */
export const SAFE_PROPERTY_VALUE_BYTES = 8 * 1024;
/** Keep at least ~100 KB below Apps Script's documented 500 KB store limit. */
export const SAFE_PROPERTY_STORE_BYTES = 400 * 1024;

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function assertSafePropertyValue(value: string, label: string): void {
  if (utf8ByteLength(value) > SAFE_PROPERTY_VALUE_BYTES) {
    throw new Error(`${label}:PROPERTY_VALUE_TOO_LARGE`);
  }
}

export function propertyStoreByteLength(properties: Readonly<Record<string, string>>): number {
  return Object.entries(properties).reduce(
    (total, [name, value]) => total + utf8ByteLength(name) + utf8ByteLength(value),
    0,
  );
}

/**
 * Validate the peak store produced by write-before-delete operations. Existing
 * values with the same name are replaced, not double counted.
 */
export function assertSafePropertyStoreWrites(
  current: Readonly<Record<string, string>>,
  writes: ReadonlyArray<{ name: string; value: string }>,
  label: string,
): void {
  const peak = new Map(Object.entries(current));
  for (const { name, value } of writes) {
    assertSafePropertyValue(value, label);
    peak.set(name, value);
  }
  if (propertyStoreByteLength(Object.fromEntries(peak)) > SAFE_PROPERTY_STORE_BYTES) {
    throw new Error(`${label}:PROPERTY_STORE_CAPACITY_EXCEEDED:P1`);
  }
}
