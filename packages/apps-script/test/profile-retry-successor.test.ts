import { describe, expect, it, vi } from "vitest";
import {
  parseProfileRetrySuccessorUid,
  persistProfileRetrySuccessorUid,
  planProfileRetrySuccessor,
  profileRetrySuccessorPropertyName,
  repairProfileRetrySuccessorUid,
  type ProfileRetrySuccessorPropertyStore,
} from "../src/domain/profile-retry-successor";
import type { ManagedTriggerSpec, TriggerDescriptor } from "../src/domain/trigger-integrity";

const NAMESPACE = "ctx_test";
const SPEC: ManagedTriggerSpec = {
  handlerFunction: "retryProfileFormSubmissions",
  eventType: "CLOCK",
  triggerSource: "CLOCK",
  triggerSourceId: "",
};

describe("profile retry successor planning", () => {
  it("creates C when marked B is executing and never lets unmarked running A suppress it", () => {
    expect(planProfileRetrySuccessor({
      queuePresent: true,
      successorUid: "uid_b",
      executingTriggerUid: "uid_b",
      triggers: [exactTrigger("uid_a"), exactTrigger("uid_b")],
      constraint: SPEC,
    })).toEqual({ action: "create" });

    expect(planProfileRetrySuccessor({
      queuePresent: true,
      successorUid: null,
      executingTriggerUid: "uid_b",
      triggers: [exactTrigger("uid_a"), exactTrigger("uid_b")],
      constraint: SPEC,
    })).toEqual({ action: "create" });
  });

  it("keeps only the marked exact future trigger and removes it when the queue drains", () => {
    expect(planProfileRetrySuccessor({
      queuePresent: true,
      successorUid: "uid_c",
      executingTriggerUid: "uid_a",
      triggers: [exactTrigger("uid_a"), exactTrigger("uid_c")],
      constraint: SPEC,
    })).toEqual({ action: "keep", uniqueId: "uid_c" });

    expect(planProfileRetrySuccessor({
      queuePresent: false,
      successorUid: "uid_c",
      executingTriggerUid: "uid_a",
      triggers: [exactTrigger("uid_c")],
      constraint: SPEC,
    })).toEqual({ action: "delete_and_clear", uniqueId: "uid_c" });

    expect(planProfileRetrySuccessor({
      queuePresent: false,
      successorUid: "uid_a",
      executingTriggerUid: "uid_a",
      triggers: [exactTrigger("uid_a")],
      constraint: SPEC,
    })).toEqual({ action: "clear" });
  });

  it("does not trust a marked UID with the wrong trigger identity", () => {
    expect(planProfileRetrySuccessor({
      queuePresent: true,
      successorUid: "uid_wrong",
      triggers: [{ ...exactTrigger("uid_wrong"), triggerSource: "FORMS" }],
      constraint: SPEC,
    })).toEqual({ action: "create" });
  });
});

describe("profile retry successor property durability", () => {
  it("accepts only a trim-stable non-control UID", () => {
    expect(parseProfileRetrySuccessorUid("uid_123-abc")).toBe("uid_123-abc");
    expect(parseProfileRetrySuccessorUid(null)).toBeNull();
    for (const invalid of ["", " uid", "uid ", "uid with space", "uid\nnext"]) {
      expect(() => parseProfileRetrySuccessorUid(invalid)).toThrow("INVALID_PROFILE_RETRY_SUCCESSOR_UID");
    }
  });

  it("quarantines a corrupt marker with hashes only before removing its source", () => {
    const sourceName = profileRetrySuccessorPropertyName(NAMESPACE);
    const raw = " invalid successor uid ";
    const store = memoryStore({ [sourceName]: raw });

    expect(repairProfileRetrySuccessorUid(store, NAMESPACE, "2026-08-28T00:00:00.000Z"))
      .toBeNull();
    const snapshot = store.getProperties();
    expect(snapshot[sourceName]).toBeUndefined();
    const quarantine = Object.entries(snapshot).find(([name]) =>
      name.startsWith("PROFILE_FORM_RETRY_SUCCESSOR_QUARANTINE_JSON:"));
    expect(quarantine).toBeDefined();
    expect(quarantine![1]).not.toContain(raw);
    expect(JSON.parse(quarantine![1])).toEqual(expect.objectContaining({
      schemaVersion: 1,
      reason: "invalid_uid",
      propertyHash: expect.stringMatching(/^fnv1a-/u),
      valueHash: expect.stringMatching(/^fnv1a-/u),
    }));
  });

  it("keeps the corrupt source when quarantine persistence fails", () => {
    const sourceName = profileRetrySuccessorPropertyName(NAMESPACE);
    const raw = " invalid ";
    const values = new Map([[sourceName, raw]]);
    const store: ProfileRetrySuccessorPropertyStore = {
      getProperties: () => Object.fromEntries(values),
      write: () => { throw new Error("SIMULATED_QUARANTINE_WRITE_FAILURE"); },
      remove: vi.fn((name: string) => values.delete(name)),
    };

    expect(() => repairProfileRetrySuccessorUid(store, NAMESPACE, "2026-08-28T00:00:00.000Z"))
      .toThrow("SIMULATED_QUARANTINE_WRITE_FAILURE");
    expect(values.get(sourceName)).toBe(raw);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("replays idempotently when source deletion failed after durable quarantine", () => {
    const sourceName = profileRetrySuccessorPropertyName(NAMESPACE);
    const values = new Map([[sourceName, " invalid "]]);
    let failDelete = true;
    const write = vi.fn((name: string, value: string) => values.set(name, value));
    const store: ProfileRetrySuccessorPropertyStore = {
      getProperties: () => Object.fromEntries(values),
      write,
      remove: (name) => {
        if (failDelete && name === sourceName) throw new Error("SIMULATED_DELETE_FAILURE");
        values.delete(name);
      },
    };

    expect(() => repairProfileRetrySuccessorUid(store, NAMESPACE, "2026-08-28T00:00:00.000Z"))
      .toThrow("SIMULATED_DELETE_FAILURE");
    const writesAfterFirstAttempt = write.mock.calls.length;
    failDelete = false;
    expect(repairProfileRetrySuccessorUid(store, NAMESPACE, "2026-08-28T00:01:00.000Z"))
      .toBeNull();
    expect(write).toHaveBeenCalledTimes(writesAfterFirstAttempt);
    expect(values.has(sourceName)).toBe(false);
  });

  it("fails when a successor marker write is not durably observable", () => {
    const store: ProfileRetrySuccessorPropertyStore = {
      getProperties: () => ({}),
      write: () => undefined,
      remove: () => undefined,
    };
    expect(() => persistProfileRetrySuccessorUid(store, NAMESPACE, "uid_next"))
      .toThrow("PROFILE_RETRY_SUCCESSOR_WRITE_NOT_DURABLE");
  });
});

function exactTrigger(uniqueId: string): TriggerDescriptor {
  return {
    handlerFunction: SPEC.handlerFunction,
    uniqueId,
    eventType: SPEC.eventType,
    triggerSource: SPEC.triggerSource,
    triggerSourceId: SPEC.triggerSourceId,
  };
}

function memoryStore(initial: Record<string, string>): ProfileRetrySuccessorPropertyStore {
  const values = new Map(Object.entries(initial));
  return {
    getProperties: () => Object.fromEntries(values),
    write: (name, value) => values.set(name, value),
    remove: (name) => values.delete(name),
  };
}
