import { describe, expect, it } from "vitest";
import {
  PROFILE_RETRY_CORRUPTION_QUARANTINE_PROPERTY_PREFIX,
  PROFILE_RETRY_PROPERTY_PREFIX,
  PROFILE_RETRY_QUARANTINE_PROPERTY_PREFIX,
  persistProfileRetryProcessingQuarantine,
  profileRetryPropertyName,
  profileRetryQuarantinePropertyName,
  profileRetryQuarantineRecord,
  repairProfileRetryProperties,
  serializeProfileRetryItem,
  type ProfileRetryItem,
  type ProfileRetryPropertyStore,
} from "../src/domain/profile-retry";

const NAMESPACE = "env_test";
const NOW = "2026-08-28T00:00:00.000Z";

describe("profile retry property repair", () => {
  it("quarantines one malformed property while retaining valid siblings", () => {
    const first = item("response_1", 0);
    const second = item("response_2", 1);
    const malformedName = `${PROFILE_RETRY_PROPERTY_PREFIX}${NAMESPACE}:raw-sensitive-property-name`;
    const store = new FakeStore(new Map([
      [profileRetryPropertyName(first, NAMESPACE), serializeProfileRetryItem(first)],
      [malformedName, "raw-sensitive-response-value"],
      [profileRetryPropertyName(second, NAMESPACE), serializeProfileRetryItem(second)],
    ]));

    expect(repairProfileRetryProperties(store, NAMESPACE, NOW).map((candidate) => candidate.responseId))
      .toEqual(["response_1", "response_2"]);
    expect(store.values.has(malformedName)).toBe(false);
    const quarantine = [...store.values.entries()].filter(([name]) =>
      name.startsWith(PROFILE_RETRY_CORRUPTION_QUARANTINE_PROPERTY_PREFIX));
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]![0]).not.toContain("sensitive");
    expect(quarantine[0]![1]).not.toContain("sensitive");
    expect(JSON.parse(quarantine[0]![1])).toEqual(expect.objectContaining({
      schemaVersion: 1,
      sourceKind: "item",
      reason: "json",
    }));
  });

  it("salvages valid legacy items, quarantines invalid siblings, and removes the aggregate", () => {
    const valid = item("response_valid", 0);
    const legacyName = `${PROFILE_RETRY_PROPERTY_PREFIX}${NAMESPACE}`;
    const store = new FakeStore(new Map([[legacyName, JSON.stringify([
      valid,
      { formId: "form-secret", responseId: "response-secret", queuedAt: "not-a-date" },
    ])]]));

    const repaired = repairProfileRetryProperties(store, NAMESPACE, NOW);
    expect(repaired).toEqual([valid]);
    expect(store.values.get(profileRetryPropertyName(valid, NAMESPACE))).toBe(serializeProfileRetryItem(valid));
    expect(store.values.has(legacyName)).toBe(false);
    const persisted = [...store.values.entries()].filter(([name]) =>
      name.startsWith(PROFILE_RETRY_CORRUPTION_QUARANTINE_PROPERTY_PREFIX));
    expect(JSON.stringify(persisted)).not.toContain("form-secret");
    expect(JSON.stringify(persisted)).not.toContain("response-secret");
  });

  it("is idempotent after canonical migration succeeds but legacy deletion fails", () => {
    const valid = item("response_replay", 0);
    const legacyName = `${PROFILE_RETRY_PROPERTY_PREFIX}${NAMESPACE}`;
    const store = new FakeStore(new Map([[legacyName, JSON.stringify([valid])]]));
    store.failRemoveNameOnce = legacyName;

    expect(() => repairProfileRetryProperties(store, NAMESPACE, NOW)).toThrow("SIMULATED_REMOVE_FAILURE");
    expect(store.values.has(legacyName)).toBe(true);
    expect(store.values.has(profileRetryPropertyName(valid, NAMESPACE))).toBe(true);

    expect(repairProfileRetryProperties(store, NAMESPACE, "2026-08-28T00:01:00.000Z"))
      .toEqual([valid]);
    expect(store.values.has(legacyName)).toBe(false);
    expect([...store.values.keys()].filter((name) =>
      name.startsWith(PROFILE_RETRY_CORRUPTION_QUARANTINE_PROPERTY_PREFIX))).toHaveLength(1);
  });

  it("leaves every source intact when corruption quarantine cannot be written", () => {
    const valid = item("response_valid", 0);
    const malformedName = `${PROFILE_RETRY_PROPERTY_PREFIX}${NAMESPACE}:malformed`;
    const initial = new Map([
      [profileRetryPropertyName(valid, NAMESPACE), serializeProfileRetryItem(valid)],
      [malformedName, "raw-secret"],
    ]);
    const store = new FakeStore(new Map(initial));
    store.failQuarantineWrite = true;

    expect(() => repairProfileRetryProperties(store, NAMESPACE, NOW)).toThrow("SIMULATED_QUARANTINE_WRITE_FAILURE");
    expect(store.values).toEqual(initial);
  });

  it("treats canonical plus legacy replay as one item and removes legacy safely", () => {
    const valid = item("response_duplicate", 0);
    const legacyName = `${PROFILE_RETRY_PROPERTY_PREFIX}${NAMESPACE}`;
    const store = new FakeStore(new Map([
      [profileRetryPropertyName(valid, NAMESPACE), serializeProfileRetryItem(valid)],
      [legacyName, JSON.stringify([valid])],
    ]));

    expect(repairProfileRetryProperties(store, NAMESPACE, NOW)).toEqual([valid]);
    expect(store.values.has(legacyName)).toBe(false);
    expect(store.values.has(profileRetryPropertyName(valid, NAMESPACE))).toBe(true);
  });

  it("persists only strict hash metadata for processing exhaustion", () => {
    const exhausted = { ...item("raw-response-secret", 0), formId: "raw-form-secret", failureCount: 5 };
    const record = profileRetryQuarantineRecord(exhausted, "processing_error", NOW);
    const store = new FakeStore(new Map());

    const name = persistProfileRetryProcessingQuarantine(store, NAMESPACE, record);
    const raw = store.values.get(name) ?? "";
    expect(name.startsWith(PROFILE_RETRY_QUARANTINE_PROPERTY_PREFIX)).toBe(true);
    expect(`${name}\n${raw}`).not.toContain("raw-response-secret");
    expect(`${name}\n${raw}`).not.toContain("raw-form-secret");
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      "failureCount", "formIdHash", "quarantineId", "quarantinedAt", "reason", "responseIdHash",
    ]);
  });

  it("fails closed on extra fields or a different failure count at a deterministic quarantine key", () => {
    const exhausted = { ...item("response_collision", 0), failureCount: 5 };
    const record = profileRetryQuarantineRecord(exhausted, "missing_response", NOW);
    const name = profileRetryQuarantinePropertyName(record, NAMESPACE);
    for (const conflicting of [
      { ...record, rawValue: "sensitive" },
      { ...record, failureCount: 4 },
    ]) {
      const store = new FakeStore(new Map([[name, JSON.stringify(conflicting)]]));
      expect(() => persistProfileRetryProcessingQuarantine(store, NAMESPACE, record))
        .toThrow("PROFILE_RETRY_QUARANTINE_CONFLICT:P1");
      expect(store.values.get(name)).toBe(JSON.stringify(conflicting));
    }
  });
});

function item(responseId: string, seconds: number): ProfileRetryItem {
  return {
    formId: "form_expected",
    responseId,
    queuedAt: new Date(Date.parse(NOW) + seconds * 1_000).toISOString(),
  };
}

class FakeStore implements ProfileRetryPropertyStore {
  failQuarantineWrite = false;
  failRemoveNameOnce = "";

  constructor(readonly values: Map<string, string>) {}

  getProperties(): Record<string, string> {
    return Object.fromEntries(this.values);
  }

  write(name: string, value: string): void {
    if (this.failQuarantineWrite && name.startsWith(PROFILE_RETRY_CORRUPTION_QUARANTINE_PROPERTY_PREFIX)) {
      throw new Error("SIMULATED_QUARANTINE_WRITE_FAILURE");
    }
    this.values.set(name, value);
  }

  remove(name: string): void {
    if (this.failRemoveNameOnce === name) {
      this.failRemoveNameOnce = "";
      throw new Error("SIMULATED_REMOVE_FAILURE");
    }
    this.values.delete(name);
  }
}
