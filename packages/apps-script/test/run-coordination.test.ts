import { afterEach, describe, expect, it, vi } from "vitest";
import { RunCoordinator, RunLeaseFenced, validateRunLease } from "../src/adapters/run-coordination";
import type { SyncCursor } from "../src/domain/types";
import { stableHash } from "../src/domain/values";

const SYNTHETIC_STRIPE_SECRET = ["sk", "live", "SYNTHETIC_TEST_ONLY"].join("_");

afterEach(() => vi.unstubAllGlobals());

describe("owner-fenced cursor coordination", () => {
  it("keeps malformed cursor inspection pure and commits only fixed reason plus a source hash", () => {
    const namespace = "privacy";
    const cursorProperty = `SYNC_CURSOR_JSON:${namespace}`;
    const raw = `{"email":"alice@example.com","token":"${SYNTHETIC_STRIPE_SECRET}",`;
    const store = trackedPropertyStore({ [cursorProperty]: raw });
    const lock = stubExclusiveScriptLock();
    const coordinator = new RunCoordinator(store.properties, 360_000, undefined, namespace);

    const inspection = coordinator.inspectCursor({ contextFingerprint: "ctx", schemaVersion: 1 });
    expect(inspection).toMatchObject({
      status: "invalid",
      reason: "INVALID_SYNC_CURSOR_JSON",
      sourceHash: stableHash(raw),
      snapshot: { kind: "sync_cursor_snapshot" },
    });
    expect(store.snapshot()).toEqual({ [cursorProperty]: raw });
    expect(store.setProperty).not.toHaveBeenCalled();
    expect(store.deleteProperty).not.toHaveBeenCalled();
    if (inspection.status !== "invalid") throw new Error("expected invalid cursor inspection");

    coordinator.claim("run_new", 100, "owner_new", inspection);
    coordinator.commitCursorQuarantine(
      inspection,
      "run_new",
      "owner_new",
      new Date("2026-08-28T00:00:00.000Z"),
    );
    coordinator.release("run_new", "owner_new");

    expect(store.get(cursorProperty)).toBeNull();
    expect(JSON.parse(store.get(`SYNC_CURSOR_QUARANTINE_JSON:${namespace}`) ?? "{}")).toEqual({
      quarantined_at: "2026-08-28T00:00:00.000Z",
      reason: "INVALID_SYNC_CURSOR_JSON",
      source_hash: stableHash(raw),
    });
    expect(JSON.stringify(store.snapshot())).not.toContain("alice@example.com");
    expect(JSON.stringify(store.snapshot())).not.toContain(SYNTHETIC_STRIPE_SECRET);
    expect(lock.isHeld()).toBe(false);
  });

  it("gives a valid inspection an opaque snapshot and fences claim when that snapshot is stale", () => {
    const namespace = "valid_stale";
    const cursorProperty = `SYNC_CURSOR_JSON:${namespace}`;
    const original = validCursor({ runId: "run_shared", phase: "account" });
    const replacement = validCursor({ runId: "run_shared", phase: "stripe_subscriptions" });
    const store = trackedPropertyStore({ [cursorProperty]: JSON.stringify(original) });
    stubExclusiveScriptLock();
    const staleCoordinator = new RunCoordinator(store.properties, 100, undefined, namespace);
    const writerCoordinator = new RunCoordinator(store.properties, 100, undefined, namespace);
    const staleInspection = staleCoordinator.inspectCursor({ contextFingerprint: "ctx", schemaVersion: 1 });
    const writerInspection = writerCoordinator.inspectCursor({ contextFingerprint: "ctx", schemaVersion: 1 });
    expect(staleInspection).toMatchObject({ status: "valid", snapshot: { kind: "sync_cursor_snapshot" } });
    if (writerInspection.status !== "valid") throw new Error("expected valid cursor inspection");

    writerCoordinator.claim("run_shared", 100, "owner_writer", writerInspection);
    writerCoordinator.writeCursor(replacement, "owner_writer");
    writerCoordinator.release("run_shared", "owner_writer");

    expect(() => staleCoordinator.claim("run_shared", 200, "owner_stale", staleInspection))
      .toThrow(RunLeaseFenced);
    expect(JSON.parse(store.get(cursorProperty) ?? "{}")).toMatchObject({ phase: "stripe_subscriptions" });
    expect(store.get("SYNC_RUN_LEASE_JSON")).toBeNull();
  });

  it("serializes quarantine compare-and-delete against another cursor writer", () => {
    const namespace = "cas";
    const cursorProperty = `SYNC_CURSOR_JSON:${namespace}`;
    const raw = "{corrupt";
    const store = trackedPropertyStore({ [cursorProperty]: raw });
    stubExclusiveScriptLock();
    const coordinator = new RunCoordinator(store.properties, 360_000, undefined, namespace);
    const inspection = coordinator.inspectCursor({ contextFingerprint: "ctx", schemaVersion: 1 });
    if (inspection.status !== "invalid") throw new Error("expected invalid cursor inspection");
    coordinator.claim("run_new", 100, "owner_new", inspection);
    let interleaveError: unknown;
    store.setGetHook(cursorProperty, () => {
      try {
        coordinator.writeCursor(validCursor({ runId: "run_new" }), "owner_new");
      } catch (error) {
        interleaveError = error;
      }
    });

    coordinator.commitCursorQuarantine(inspection, "run_new", "owner_new");

    expect(interleaveError).toBeInstanceOf(Error);
    expect((interleaveError as Error).message).toBe("SYNC_LOCK_BUSY");
    expect(store.get(cursorProperty)).toBeNull();
    expect(store.get(`SYNC_CURSOR_QUARANTINE_JSON:${namespace}`)).not.toBeNull();
    coordinator.release("run_new", "owner_new");
  });

  it("prevents an old owner from writing or clearing a same-run cursor after lease takeover", () => {
    const namespace = "takeover";
    const cursorProperty = `SYNC_CURSOR_JSON:${namespace}`;
    const cursor = validCursor({ runId: "run_shared" });
    const store = trackedPropertyStore({ [cursorProperty]: JSON.stringify(cursor) });
    stubExclusiveScriptLock();
    const oldCoordinator = new RunCoordinator(store.properties, 100, undefined, namespace);
    const newCoordinator = new RunCoordinator(store.properties, 100, undefined, namespace);
    const oldInspection = oldCoordinator.inspectCursor({ contextFingerprint: "ctx", schemaVersion: 1 });
    oldCoordinator.claim("run_shared", 100, "owner_old", oldInspection);
    const takeoverInspection = newCoordinator.inspectCursor({ contextFingerprint: "ctx", schemaVersion: 1 });
    newCoordinator.claim("run_shared", 1_000, "owner_new", takeoverInspection);
    const replacement = validCursor({ runId: "run_shared", phase: "ghost_members" });
    newCoordinator.writeCursor(replacement, "owner_new");

    expect(() => oldCoordinator.writeCursor(validCursor({ runId: "run_shared", phase: "reconcile" }), "owner_old"))
      .toThrow(RunLeaseFenced);
    expect(() => oldCoordinator.clearCursor("run_shared", "owner_old")).toThrow(RunLeaseFenced);
    expect(JSON.parse(store.get(cursorProperty) ?? "{}")).toMatchObject({ phase: "ghost_members" });
    expect(JSON.parse(store.get("SYNC_RUN_LEASE_JSON") ?? "{}")).toMatchObject({ ownerId: "owner_new" });
  });

  it("quarantines a malformed lease with a fixed reason/hash and no raw PII", () => {
    const rawLease = `{"owner":"alice@example.com","secret":"${SYNTHETIC_STRIPE_SECRET}",`;
    const store = trackedPropertyStore({ SYNC_RUN_LEASE_JSON: rawLease });
    stubExclusiveScriptLock();
    const coordinator = new RunCoordinator(store.properties);
    const inspection = coordinator.inspectCursor({ contextFingerprint: "ctx", schemaVersion: 1 });

    coordinator.claim("run_new", 100, "owner_new", inspection);

    expect(JSON.parse(store.get("SYNC_RUN_LEASE_QUARANTINE_JSON") ?? "{}")).toEqual({
      quarantined_at: new Date(100).toISOString(),
      reason: "INVALID_SYNC_RUN_LEASE",
      source_hash: stableHash(rawLease),
    });
    expect(JSON.stringify(store.snapshot())).not.toContain("alice@example.com");
    expect(JSON.stringify(store.snapshot())).not.toContain(SYNTHETIC_STRIPE_SECRET);
    expect(JSON.parse(store.get("SYNC_RUN_LEASE_JSON") ?? "{}")).toMatchObject({
      runId: "run_new",
      ownerId: "owner_new",
    });
  });

  it("fails closed and preserves a malformed lease when its hash-only quarantine cannot be written", () => {
    const rawLease = `{"secret":"${SYNTHETIC_STRIPE_SECRET}",`;
    const store = trackedPropertyStore({ SYNC_RUN_LEASE_JSON: rawLease }, "SYNC_RUN_LEASE_QUARANTINE_JSON");
    stubExclusiveScriptLock();
    const coordinator = new RunCoordinator(store.properties);
    const inspection = coordinator.inspectCursor({ contextFingerprint: "ctx", schemaVersion: 1 });

    expect(() => coordinator.claim("run_new", 100, "owner_new", inspection))
      .toThrow("SIMULATED_PROPERTY_WRITE_FAILURE");
    expect(store.get("SYNC_RUN_LEASE_JSON")).toBe(rawLease);
    expect(store.get("SYNC_RUN_LEASE_QUARANTINE_JSON")).toBeNull();
  });

  it("fences an expired execution after a new owner has taken over the same run cursor", () => {
    const store = trackedPropertyStore({
      SYNC_RUN_LEASE_JSON: JSON.stringify({ runId: "run_shared", ownerId: "owner_new", expiresAtMs: 10_000 }),
    });
    const lock = stubExclusiveScriptLock();
    const coordinator = new RunCoordinator(store.properties);

    expect(() => coordinator.renew("run_shared", 2_000, "owner_old")).toThrow(RunLeaseFenced);
    expect(store.setProperty).not.toHaveBeenCalled();
    expect(lock.isHeld()).toBe(false);
  });

  it("never lets renew acquire an absent or expired lease", () => {
    const absentStore = trackedPropertyStore({});
    stubExclusiveScriptLock();
    const absentCoordinator = new RunCoordinator(absentStore.properties, 100);

    expect(() => absentCoordinator.renew("run_shared", 100, "owner_old")).toThrow(RunLeaseFenced);
    expect(absentStore.setProperty).not.toHaveBeenCalled();

    const expiredStore = trackedPropertyStore({
      SYNC_RUN_LEASE_JSON: JSON.stringify({ runId: "run_shared", ownerId: "owner_old", expiresAtMs: 199 }),
    });
    const expiredCoordinator = new RunCoordinator(expiredStore.properties, 100);

    expect(() => expiredCoordinator.renew("run_shared", 200, "owner_old")).toThrow(RunLeaseFenced);
    expect(expiredStore.setProperty).not.toHaveBeenCalled();
    expect(JSON.parse(expiredStore.get("SYNC_RUN_LEASE_JSON") ?? "{}")).toEqual({
      runId: "run_shared",
      ownerId: "owner_old",
      expiresAtMs: 199,
    });
  });

  it("cannot revive or roll back a cursor after a same-run owner takes over and releases", () => {
    const namespace = "released_takeover";
    const cursorProperty = `SYNC_CURSOR_JSON:${namespace}`;
    const original = validCursor({ runId: "run_shared", phase: "account" });
    const replacement = validCursor({ runId: "run_shared", phase: "ghost_members" });
    const store = trackedPropertyStore({ [cursorProperty]: JSON.stringify(original) });
    stubExclusiveScriptLock();
    const oldCoordinator = new RunCoordinator(store.properties, 100, undefined, namespace);
    const newCoordinator = new RunCoordinator(store.properties, 100, undefined, namespace);

    const oldInspection = oldCoordinator.inspectCursor({ contextFingerprint: "ctx", schemaVersion: 1 });
    oldCoordinator.claim("run_shared", 100, "owner_old", oldInspection);
    const takeoverInspection = newCoordinator.inspectCursor({ contextFingerprint: "ctx", schemaVersion: 1 });
    newCoordinator.claim("run_shared", 300, "owner_new", takeoverInspection);
    newCoordinator.writeCursor(replacement, "owner_new");

    // Even after the replacement owner's lease has expired, the old owner is
    // still fenced by owner identity and cannot roll the cursor backward.
    expect(() => oldCoordinator.renew("run_shared", 500, "owner_old")).toThrow(RunLeaseFenced);
    expect(() => oldCoordinator.writeCursor(original, "owner_old")).toThrow(RunLeaseFenced);

    newCoordinator.release("run_shared", "owner_new");
    expect(store.get("SYNC_RUN_LEASE_JSON")).toBeNull();
    expect(() => oldCoordinator.renew("run_shared", 501, "owner_old")).toThrow(RunLeaseFenced);
    expect(() => oldCoordinator.writeCursor(original, "owner_old")).toThrow(RunLeaseFenced);
    expect(JSON.parse(store.get(cursorProperty) ?? "{}")).toMatchObject({ phase: "ghost_members" });
  });

  it("rejects unknown lease fields and unsafe expiry values", () => {
    expect(() => validateRunLease({ runId: "run", expiresAtMs: 1, unexpected: true })).toThrow("INVALID_SYNC_RUN_LEASE:fields");
    expect(() => validateRunLease({ runId: "run", expiresAtMs: Number.POSITIVE_INFINITY })).toThrow("INVALID_SYNC_RUN_LEASE:expires_at");
  });
});

function validCursor(overrides: Partial<SyncCursor> = {}): SyncCursor {
  return {
    schemaVersion: 1,
    contextFingerprint: "ctx",
    runId: "run_test",
    requestedRunType: "hourly",
    phase: "account",
    startedAt: "2026-08-28T00:00:00.000Z",
    stats: { ghostPages: 0, ghostRecords: 0, stripePages: 0, stripeRecords: 0, billingPages: 0, billingRecords: 0 },
    ...overrides,
  };
}

function stubExclusiveScriptLock(): { isHeld: () => boolean } {
  let held = false;
  vi.stubGlobal("LockService", {
    getScriptLock: () => ({
      tryLock: () => {
        if (held) return false;
        held = true;
        return true;
      },
      waitLock: () => {
        if (held) throw new Error("SYNC_LOCK_BUSY");
        held = true;
      },
      releaseLock: () => { held = false; },
    }),
  });
  return { isHeld: () => held };
}

function trackedPropertyStore(initial: Record<string, string>, failSetName?: string) {
  const values = new Map(Object.entries(initial));
  const getHooks = new Map<string, () => void>();
  const getProperty = vi.fn((name: string) => {
    const hook = getHooks.get(name);
    if (hook) {
      getHooks.delete(name);
      hook();
    }
    return values.get(name) ?? null;
  });
  const setProperty = vi.fn((name: string, value: string) => {
    if (name === failSetName) throw new Error("SIMULATED_PROPERTY_WRITE_FAILURE");
    values.set(name, value);
    return undefined;
  });
  const deleteProperty = vi.fn((name: string) => { values.delete(name); return undefined; });
  const properties = {
    getProperty,
    getProperties: vi.fn(() => Object.fromEntries(values)),
    setProperty,
    deleteProperty,
  } as unknown as GoogleAppsScript.Properties.Properties;
  return {
    properties,
    setProperty,
    deleteProperty,
    get: (name: string) => values.get(name) ?? null,
    snapshot: () => Object.fromEntries(values),
    setGetHook: (name: string, hook: () => void) => { getHooks.set(name, hook); },
  };
}
