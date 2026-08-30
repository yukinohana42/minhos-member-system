import { describe, expect, it } from "vitest";
import {
  assertSafePropertyStoreWrites,
  propertyStoreByteLength,
  SAFE_PROPERTY_STORE_BYTES,
} from "../src/domain/property-quota";

describe("global Script Properties budget", () => {
  it("counts UTF-8 property names and values while allowing an overwrite", () => {
    const current = { key: "old", "日本語": "値" };
    expect(propertyStoreByteLength(current)).toBeGreaterThan("keyold".length);
    expect(() => assertSafePropertyStoreWrites(
      current,
      [{ name: "key", value: "new" }],
      "TEST_STORE",
    )).not.toThrow();
  });

  it("reserves headroom below the provider store limit and fails before write", () => {
    const current = { existing: "x".repeat(SAFE_PROPERTY_STORE_BYTES - 20) };
    expect(() => assertSafePropertyStoreWrites(
      current,
      [{ name: "new", value: "0123456789" }],
      "TEST_STORE",
    )).toThrow("TEST_STORE:PROPERTY_STORE_CAPACITY_EXCEEDED:P1");
  });
});
