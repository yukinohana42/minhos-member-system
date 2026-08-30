import { afterEach, describe, expect, it, vi } from "vitest";
import type { GhostAdminClient } from "../src/adapters/ghost-admin-client";
import {
  RunCoordinator,
  RunLeaseFenced,
  type SyncCursorInspection,
  type SyncCursorQuarantineReason,
} from "../src/adapters/run-coordination";
import type { SheetsRepository } from "../src/adapters/sheets-repository";
import type { StripeReadOnlyClient } from "../src/adapters/stripe-client";
import type { SyncConfig } from "../src/config";
import {
  enqueueNotificationOutbox,
  NOTIFICATION_OUTBOX_QUARANTINE_PROPERTY_PREFIX,
  notificationOutboxPropertyName,
  serializeNotificationOutboxItem,
} from "../src/domain/notification-outbox";
import type { ExceptionRow } from "../src/domain/types";
import { syncContextFingerprint } from "../src/domain/sync-context";
import { stableHash } from "../src/domain/values";
import { SyncService } from "../src/sync/sync-service";

const SYNTHETIC_STRIPE_SECRET = ["sk", "live", "SYNTHETIC_TEST_ONLY"].join("_");
const SYNTHETIC_RESTRICTED_SECRET = ["rk", "live", "SYNTHETIC_TEST_ONLY"].join("_");

afterEach(() => vi.unstubAllGlobals());

describe("sync environment preflight", () => {
  it("records and notifies a quarantined cursor after environment preflight, then stops an unsafe resume", () => {
    vi.stubGlobal("LockService", {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => undefined }),
    });
    const upsert = vi.fn((_name: string, rows: unknown[]) => ({ inserted: rows.length, updated: 0, unchanged: 0 }));
    const appendSyncLog = vi.fn();
    const preflightIdentityIntegrity = vi.fn();
    const repository = {
      preflightEnvironmentMarker: vi.fn(), preflightIdentityIntegrity,
      read: vi.fn(() => []), upsert, appendSyncLog,
    } as unknown as SheetsRepository;
    const renew = vi.fn();
    const claim = vi.fn();
    const assertOwner = vi.fn();
    const commitCursorQuarantine = vi.fn();
    const coordinator = {
      inspectCursor: vi.fn(() => invalidCursorInspection("INVALID_SYNC_CURSOR_SCHEMA")),
      commitCursorQuarantine,
      claim, renew, assertOwner, release: vi.fn(),
    } as unknown as RunCoordinator;
    const sendMail = vi.fn();
    const properties = fakeProperties();
    const service = new SyncService({
      config: config(), properties,
      repository, coordinator, ghost: {} as GhostAdminClient, stripe: {} as StripeReadOnlyClient,
      now: () => new Date("2026-08-28T00:00:00.000Z"), uuid: () => "uuid", sendMail, setRetryDeadline: vi.fn(),
    });

    expect(() => service.run("resume")).not.toThrow();
    expect(repository.preflightEnvironmentMarker).toHaveBeenCalledOnce();
    expect(preflightIdentityIntegrity).toHaveBeenCalledTimes(2);
    expect(renew).toHaveBeenCalledOnce();
    expect(preflightIdentityIntegrity.mock.invocationCallOrder[0])
      .toBeLessThan(claim.mock.invocationCallOrder[0]!);
    expect(renew.mock.invocationCallOrder[0])
      .toBeLessThan(preflightIdentityIntegrity.mock.invocationCallOrder[1]!);
    expect(preflightIdentityIntegrity.mock.invocationCallOrder[1])
      .toBeLessThan(assertOwner.mock.invocationCallOrder[0]!);
    expect(assertOwner.mock.invocationCallOrder[0])
      .toBeLessThan(commitCursorQuarantine.mock.invocationCallOrder[0]!);
    expect(commitCursorQuarantine.mock.invocationCallOrder[0])
      .toBeLessThan(upsert.mock.invocationCallOrder[0]!);
    expect(upsert).toHaveBeenCalledWith("50_Exceptions", expect.any(Array));
    expect(appendSyncLog).toHaveBeenCalledWith(expect.objectContaining({ completed: false }));
    expect(sendMail).toHaveBeenCalledOnce();
    expect(coordinator.release).toHaveBeenCalled();
  });

  it("keeps a failed notification pending and retries it idempotently on the next run", () => {
    vi.stubGlobal("LockService", {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => undefined }),
    });
    const properties = fakeProperties();
    let exceptions: Array<Record<string, unknown>> = [];
    const repository = {
      preflightEnvironmentMarker: vi.fn(),
      preflightIdentityIntegrity: vi.fn(),
      read: vi.fn((name: string) => name === "50_Exceptions" ? exceptions.map((row) => ({ ...row })) : []),
      upsert: vi.fn((name: string, rows: Array<Record<string, unknown>>) => {
        if (name === "50_Exceptions") {
          for (const row of rows) {
            const index = exceptions.findIndex((candidate) => candidate.exception_key === row.exception_key);
            if (index >= 0) exceptions[index] = { ...row };
            else exceptions.push({ ...row });
          }
        }
        return { inserted: rows.length, updated: 0, unchanged: 0 };
      }),
      appendSyncLog: vi.fn(),
    } as unknown as SheetsRepository;
    const coordinator = {
      inspectCursor: vi.fn(() => invalidCursorInspection("INVALID_SYNC_CURSOR_SCHEMA")),
      commitCursorQuarantine: vi.fn(),
      claim: vi.fn(), renew: vi.fn(), assertOwner: vi.fn(), release: vi.fn(),
    } as unknown as RunCoordinator;
    const sendMail = vi.fn()
      .mockImplementationOnce(() => { throw new Error("MAIL_UNAVAILABLE"); })
      .mockImplementationOnce(() => undefined);
    const service = new SyncService({
      config: config(), properties, repository, coordinator,
      ghost: {} as GhostAdminClient, stripe: {} as StripeReadOnlyClient,
      now: () => new Date("2026-08-28T00:00:00.000Z"), uuid: () => "uuid", sendMail, setRetryDeadline: vi.fn(),
    });

    service.run("resume");
    const key = Object.keys(properties.getProperties()).find((candidate) => candidate.startsWith("NOTIFICATION_OUTBOX_JSON:"));
    expect(key).toBeDefined();
    expect(JSON.parse(properties.getProperty(key!) ?? "{}"))
      .toMatchObject({ deliveryState: "pending" });
    expect(exceptions[0]?.last_notified_at).toBe("");

    service.run("resume");
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(properties.getProperty(key!)).toBeNull();
    expect(exceptions[0]?.last_notified_at).toBe("2026-08-28T00:00:00.000Z");
  });

  it("leaves Sheet, cursor, Properties, and mail unchanged when a quarantined resume fails identity preflight", () => {
    const writes = {
      upsert: vi.fn(),
      replace: vi.fn(),
      appendSyncLog: vi.fn(),
      writeDashboard: vi.fn(),
      upsertOwnedRowsInPlace: vi.fn(),
    };
    const preflightIdentityIntegrity = vi.fn(() => {
      throw new Error("SHEET_IDENTITY_INTEGRITY_FAILED");
    });
    const repository = {
      preflightEnvironmentMarker: vi.fn(),
      preflightIdentityIntegrity,
      read: vi.fn(() => []),
      ...writes,
    } as unknown as SheetsRepository;
    const claim = vi.fn();
    const renew = vi.fn();
    const release = vi.fn();
    const cursorWrites = {
      commitCursorQuarantine: vi.fn(),
      writeCursor: vi.fn(),
      scheduleResume: vi.fn(),
      clearCursor: vi.fn(),
    };
    const coordinator = {
      inspectCursor: vi.fn(() => invalidCursorInspection("INVALID_SYNC_CURSOR_SCHEMA")),
      claim,
      renew,
      assertOwner: vi.fn(),
      release,
      ...cursorWrites,
    } as unknown as RunCoordinator;
    const properties = fakeProperties();
    const sendMail = vi.fn();
    const service = new SyncService({
      config: config(), properties, repository, coordinator,
      ghost: {} as GhostAdminClient, stripe: {} as StripeReadOnlyClient,
      now: () => new Date("2026-08-28T00:00:00.000Z"), uuid: () => "uuid", sendMail, setRetryDeadline: vi.fn(),
    });

    expect(() => service.run("resume")).toThrow("SHEET_IDENTITY_INTEGRITY_FAILED");
    expect(preflightIdentityIntegrity).toHaveBeenCalledOnce();
    expect(claim).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
    Object.values(writes).forEach((write) => expect(write).not.toHaveBeenCalled());
    Object.values(cursorWrites).forEach((write) => expect(write).not.toHaveBeenCalled());
    expect(properties.setProperty).not.toHaveBeenCalled();
    expect(properties.deleteProperty).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("causes zero Sheet writes and never records a failure when the marker mismatches", () => {
    const writes = {
      upsert: vi.fn(),
      replace: vi.fn(),
      appendSyncLog: vi.fn(),
      writeDashboard: vi.fn(),
      upsertOwnedRowsInPlace: vi.fn(),
    };
    const repository = {
      preflightEnvironmentMarker: vi.fn(() => { throw new Error("SHEET_ENVIRONMENT_MARKER_MISMATCH"); }),
      preflightIdentityIntegrity: vi.fn(),
      ...writes,
    } as unknown as SheetsRepository;
    const claim = vi.fn();
    const coordinator = {
      inspectCursor: vi.fn(() => absentCursorInspection()),
      claim,
    } as unknown as RunCoordinator;
    const propertyWrite = vi.fn();
    const service = new SyncService({
      config: config(),
      properties: {
        getProperty: vi.fn(() => null),
        setProperty: propertyWrite,
      } as unknown as GoogleAppsScript.Properties.Properties,
      repository,
      coordinator,
      ghost: {} as GhostAdminClient,
      stripe: {} as StripeReadOnlyClient,
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      uuid: () => "uuid",
      sendMail: vi.fn(),
      setRetryDeadline: vi.fn(),
    });

    expect(() => service.run("manual")).toThrow("SHEET_ENVIRONMENT_MARKER_MISMATCH");
    expect(claim).not.toHaveBeenCalled();
    expect(propertyWrite).not.toHaveBeenCalled();
    Object.values(writes).forEach((write) => expect(write).not.toHaveBeenCalled());
  });

  it("uses real cursor inspection and leaves a corrupt cursor durably unchanged when the marker fails", () => {
    stubScriptLock();
    const namespace = "marker_failure";
    const cursorProperty = `SYNC_CURSOR_JSON:${namespace}`;
    const initial = { [cursorProperty]: "{corrupt" };
    const propertyStore = trackedProperties(initial);
    const sheetWrites = repositoryWriteSpies();
    const repository = {
      preflightEnvironmentMarker: vi.fn(() => { throw new Error("SHEET_ENVIRONMENT_MARKER_MISMATCH"); }),
      preflightIdentityIntegrity: vi.fn(),
      read: vi.fn(() => []),
      ...sheetWrites,
    } as unknown as SheetsRepository;
    const sendMail = vi.fn();
    const service = new SyncService({
      config: config(),
      properties: propertyStore.properties,
      repository,
      coordinator: new RunCoordinator(propertyStore.properties, 360_000, undefined, namespace),
      ghost: {} as GhostAdminClient,
      stripe: {} as StripeReadOnlyClient,
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      uuid: () => "uuid",
      sendMail,
      setRetryDeadline: vi.fn(),
    });

    expect(() => service.run("resume")).toThrow("SHEET_ENVIRONMENT_MARKER_MISMATCH");
    expect(propertyStore.snapshot()).toEqual(initial);
    expect(propertyStore.setProperty).not.toHaveBeenCalled();
    expect(propertyStore.deleteProperty).not.toHaveBeenCalled();
    expect(repository.preflightIdentityIntegrity).not.toHaveBeenCalled();
    Object.values(sheetWrites).forEach((write) => expect(write).not.toHaveBeenCalled());
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("keeps cursor and malformed lease observation-only when the first real identity preflight fails", () => {
    stubScriptLock();
    const namespace = "identity_failure";
    const cursorProperty = `SYNC_CURSOR_JSON:${namespace}`;
    const initial = {
      [cursorProperty]: "{corrupt",
      SYNC_RUN_LEASE_JSON: `{"email":"alice@example.com","secret":"${SYNTHETIC_STRIPE_SECRET}",`,
    };
    const propertyStore = trackedProperties(initial);
    const sheetWrites = repositoryWriteSpies();
    const repository = {
      preflightEnvironmentMarker: vi.fn(),
      preflightIdentityIntegrity: vi.fn(() => { throw new Error("SHEET_IDENTITY_INTEGRITY_FAILED"); }),
      read: vi.fn(() => []),
      ...sheetWrites,
    } as unknown as SheetsRepository;
    const sendMail = vi.fn();
    const service = new SyncService({
      config: config(),
      properties: propertyStore.properties,
      repository,
      coordinator: new RunCoordinator(propertyStore.properties, 360_000, undefined, namespace),
      ghost: {} as GhostAdminClient,
      stripe: {} as StripeReadOnlyClient,
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      uuid: () => "uuid",
      sendMail,
      setRetryDeadline: vi.fn(),
    });

    expect(() => service.run("resume")).toThrow("SHEET_IDENTITY_INTEGRITY_FAILED");
    expect(propertyStore.snapshot()).toEqual(initial);
    expect(propertyStore.setProperty).not.toHaveBeenCalled();
    expect(propertyStore.deleteProperty).not.toHaveBeenCalled();
    Object.values(sheetWrites).forEach((write) => expect(write).not.toHaveBeenCalled());
    expect(sendMail).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "corrupt",
      raw: `{"email":"alice@example.com","secret":"${SYNTHETIC_STRIPE_SECRET}",`,
      leaseRaw: `{"email":"lease@example.com","secret":"${SYNTHETIC_RESTRICTED_SECRET}",`,
      expectedReason: "INVALID_SYNC_CURSOR_JSON",
    },
    {
      name: "context-incompatible",
      raw: incompatibleCursorJson(),
      leaseRaw: undefined,
      expectedReason: "SYNC_CONTEXT_FINGERPRINT_MISMATCH",
    },
  ])("commits durable quarantine for a $name cursor only after all real preflights", ({ raw, leaseRaw, expectedReason }) => {
    stubScriptLock();
    const namespace = "successful_preflight";
    const cursorProperty = `SYNC_CURSOR_JSON:${namespace}`;
    const quarantineProperty = `SYNC_CURSOR_QUARANTINE_JSON:${namespace}`;
    const propertyStore = trackedProperties({
      [cursorProperty]: raw,
      ...(leaseRaw ? { SYNC_RUN_LEASE_JSON: leaseRaw } : {}),
    });
    let exceptionRows: ExceptionRow[] = [];
    const preflightEnvironmentMarker = vi.fn();
    const preflightIdentityIntegrity = vi.fn();
    const upsert = vi.fn((name: string, rows: ExceptionRow[]) => {
      if (name === "50_Exceptions") exceptionRows = rows.map((row) => ({ ...row }));
      return { inserted: rows.length, updated: 0, unchanged: 0 };
    });
    const appendSyncLog = vi.fn();
    const repository = {
      preflightEnvironmentMarker,
      preflightIdentityIntegrity,
      read: vi.fn((name: string) => name === "50_Exceptions" ? exceptionRows.map((row) => ({ ...row })) : []),
      upsert,
      appendSyncLog,
    } as unknown as SheetsRepository;
    const coordinator = new RunCoordinator(propertyStore.properties, 360_000, undefined, namespace);
    const claim = vi.spyOn(coordinator, "claim");
    const renew = vi.spyOn(coordinator, "renew");
    const assertOwner = vi.spyOn(coordinator, "assertOwner");
    const commitCursorQuarantine = vi.spyOn(coordinator, "commitCursorQuarantine");
    const sendMail = vi.fn();
    const service = new SyncService({
      config: config(), properties: propertyStore.properties, repository, coordinator,
      ghost: {} as GhostAdminClient, stripe: {} as StripeReadOnlyClient,
      now: () => new Date("2026-08-28T00:00:00.000Z"), uuid: () => "uuid", sendMail, setRetryDeadline: vi.fn(),
    });

    expect(() => service.run("resume")).not.toThrow();
    expect(preflightEnvironmentMarker.mock.invocationCallOrder[0]).toBeLessThan(claim.mock.invocationCallOrder[0]!);
    expect(preflightIdentityIntegrity).toHaveBeenCalledTimes(2);
    expect(preflightEnvironmentMarker.mock.invocationCallOrder[0])
      .toBeLessThan(preflightIdentityIntegrity.mock.invocationCallOrder[0]!);
    expect(preflightIdentityIntegrity.mock.invocationCallOrder[0])
      .toBeLessThan(claim.mock.invocationCallOrder[0]!);
    expect(claim.mock.invocationCallOrder[0]).toBeLessThan(renew.mock.invocationCallOrder[0]!);
    expect(renew.mock.invocationCallOrder[0]).toBeLessThan(preflightIdentityIntegrity.mock.invocationCallOrder[1]!);
    expect(preflightIdentityIntegrity.mock.invocationCallOrder[1])
      .toBeLessThan(assertOwner.mock.invocationCallOrder[0]!);
    expect(assertOwner.mock.invocationCallOrder[0])
      .toBeLessThan(commitCursorQuarantine.mock.invocationCallOrder[0]!);
    expect(commitCursorQuarantine.mock.invocationCallOrder[0]).toBeLessThan(upsert.mock.invocationCallOrder[0]!);
    expect(propertyStore.properties.getProperty(cursorProperty)).toBeNull();
    const quarantine = JSON.parse(propertyStore.properties.getProperty(quarantineProperty) ?? "{}");
    expect(quarantine).toEqual({
      quarantined_at: "2026-08-28T00:00:00.000Z",
      reason: expectedReason,
      source_hash: stableHash(raw),
    });
    if (leaseRaw) {
      expect(JSON.parse(propertyStore.properties.getProperty("SYNC_RUN_LEASE_QUARANTINE_JSON") ?? "{}")).toEqual({
        quarantined_at: "2026-08-28T00:00:00.000Z",
        reason: "INVALID_SYNC_RUN_LEASE",
        source_hash: stableHash(leaseRaw),
      });
    }
    expect(propertyStore.properties.getProperty("SYNC_RUN_LEASE_JSON")).toBeNull();
    expect(appendSyncLog).toHaveBeenCalledWith(expect.objectContaining({
      completed: false,
      run_type: "manual",
      error_summary: expect.stringContaining("SYNC_CURSOR_QUARANTINED"),
    }));
    expect(sendMail).toHaveBeenCalledOnce();
    const durableAndOperationalOutput = JSON.stringify({
      properties: propertyStore.snapshot(),
      logs: appendSyncLog.mock.calls,
      rows: exceptionRows,
      mail: sendMail.mock.calls,
    });
    expect(durableAndOperationalOutput).not.toContain("alice@example.com");
    expect(durableAndOperationalOutput).not.toContain(SYNTHETIC_STRIPE_SECRET);
    expect(durableAndOperationalOutput).not.toContain("lease@example.com");
    expect(durableAndOperationalOutput).not.toContain(SYNTHETIC_RESTRICTED_SECRET);

    const durableAfterQuarantine = propertyStore.snapshot();
    service.run("resume");
    expect(propertyStore.snapshot()).toEqual(durableAfterQuarantine);
    expect(preflightEnvironmentMarker).toHaveBeenCalledOnce();
  });

  it("fences a valid resume when another real owner takes over during identity preflight", () => {
    stubScriptLock();
    const syncConfig = config();
    const namespace = "identity_takeover";
    const cursorProperty = `SYNC_CURSOR_JSON:${namespace}`;
    const cursor = {
      schemaVersion: syncConfig.schemaVersion,
      contextFingerprint: syncContextFingerprint(syncConfig),
      runId: "run_shared",
      requestedRunType: "hourly" as const,
      phase: "account" as const,
      startedAt: "2026-08-28T00:00:00.000Z",
      stats: { ghostPages: 0, ghostRecords: 0, stripePages: 0, stripeRecords: 0, billingPages: 0, billingRecords: 0 },
    };
    const rawCursor = JSON.stringify(cursor);
    const propertyStore = trackedProperties({ [cursorProperty]: rawCursor });
    const serviceCoordinator = new RunCoordinator(propertyStore.properties, 100, undefined, namespace);
    const takeoverCoordinator = new RunCoordinator(propertyStore.properties, 100, undefined, namespace);
    let identityCalls = 0;
    const preflightIdentityIntegrity = vi.fn(() => {
      identityCalls += 1;
      if (identityCalls !== 2) return;
      const inspection = takeoverCoordinator.inspectCursor({
        contextFingerprint: cursor.contextFingerprint,
        schemaVersion: cursor.schemaVersion,
      });
      takeoverCoordinator.claim(cursor.runId, 1_000, "owner_new", inspection);
    });
    const sheetWrites = repositoryWriteSpies();
    const repository = {
      preflightEnvironmentMarker: vi.fn(),
      preflightIdentityIntegrity,
      read: vi.fn(() => []),
      ...sheetWrites,
    } as unknown as SheetsRepository;
    const sendMail = vi.fn();
    const service = new SyncService({
      config: syncConfig,
      properties: propertyStore.properties,
      repository,
      coordinator: serviceCoordinator,
      ghost: {} as GhostAdminClient,
      stripe: {} as StripeReadOnlyClient,
      now: () => new Date(100),
      uuid: () => "uuid",
      sendMail,
      setRetryDeadline: vi.fn(),
    });

    expect(() => service.run("resume")).not.toThrow();
    expect(preflightIdentityIntegrity).toHaveBeenCalledTimes(2);
    expect(propertyStore.properties.getProperty(cursorProperty)).toBe(rawCursor);
    expect(JSON.parse(propertyStore.properties.getProperty("SYNC_RUN_LEASE_JSON") ?? "{}")).toMatchObject({
      runId: "run_shared",
      ownerId: "owner_new",
    });
    Object.values(sheetWrites).forEach((write) => expect(write).not.toHaveBeenCalled());
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("lets a fenced stale execution exit without cursor, failure, or Sheet writes", () => {
    const writes = {
      upsert: vi.fn(), replace: vi.fn(), appendSyncLog: vi.fn(), writeDashboard: vi.fn(), upsertOwnedRowsInPlace: vi.fn(),
    };
    const repository = {
      preflightEnvironmentMarker: vi.fn(),
      preflightIdentityIntegrity: vi.fn(),
      ...writes,
    } as unknown as SheetsRepository;
    const writeCursor = vi.fn();
    const release = vi.fn();
    const coordinator = {
      inspectCursor: vi.fn(() => absentCursorInspection()),
      claim: vi.fn(),
      renew: vi.fn(() => { throw new RunLeaseFenced(); }),
      assertOwner: vi.fn(),
      writeCursor,
      release,
    } as unknown as RunCoordinator;
    const propertyWrite = vi.fn();
    const service = new SyncService({
      config: config(),
      properties: { getProperty: vi.fn(() => null), setProperty: propertyWrite } as unknown as GoogleAppsScript.Properties.Properties,
      repository,
      coordinator,
      ghost: {} as GhostAdminClient,
      stripe: {} as StripeReadOnlyClient,
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      uuid: () => "uuid",
      sendMail: vi.fn(),
      setRetryDeadline: vi.fn(),
    });

    expect(() => service.run("manual")).not.toThrow();
    expect(writeCursor).not.toHaveBeenCalled();
    expect(propertyWrite).not.toHaveBeenCalled();
    Object.values(writes).forEach((write) => expect(write).not.toHaveBeenCalled());
    expect(release).toHaveBeenCalledWith("run_uuid", "lease_uuid");
  });

  it("rechecks the lease before failure recording after an API call loses ownership", () => {
    const writes = {
      upsert: vi.fn(), replace: vi.fn(), appendSyncLog: vi.fn(), writeDashboard: vi.fn(), upsertOwnedRowsInPlace: vi.fn(),
    };
    const repository = {
      preflightEnvironmentMarker: vi.fn(), preflightIdentityIntegrity: vi.fn(), ...writes,
    } as unknown as SheetsRepository;
    const renew = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new RunLeaseFenced(); });
    const writeCursor = vi.fn();
    const coordinator = {
      inspectCursor: vi.fn(() => absentCursorInspection()), claim: vi.fn(), renew, assertOwner: vi.fn(), writeCursor, release: vi.fn(),
    } as unknown as RunCoordinator;
    const propertyWrite = vi.fn();
    const service = new SyncService({
      config: config(),
      properties: { getProperty: vi.fn(() => null), setProperty: propertyWrite } as unknown as GoogleAppsScript.Properties.Properties,
      repository,
      coordinator,
      ghost: {} as GhostAdminClient,
      stripe: { getAccount: () => { throw new Error("SCHEMA_MISMATCH:stripe_account"); } } as unknown as StripeReadOnlyClient,
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      uuid: () => "uuid",
      sendMail: vi.fn(),
      setRetryDeadline: vi.fn(),
    });

    expect(() => service.run("manual")).not.toThrow();
    expect(renew).toHaveBeenCalledTimes(2);
    expect(writeCursor).toHaveBeenCalledTimes(1);
    expect(propertyWrite).not.toHaveBeenCalled();
    Object.values(writes).forEach((write) => expect(write).not.toHaveBeenCalled());
  });

  it("repairs a corrupt sibling inside the shared ScriptLock before delivering a valid item", () => {
    let held = false;
    vi.stubGlobal("LockService", {
      getScriptLock: () => ({
        tryLock: () => { held = true; return true; },
        releaseLock: () => { held = false; },
      }),
    });
    const properties = fakeProperties();
    const context = syncContextFingerprint(config());
    const valid = enqueueNotificationOutbox([], [{
      exceptionKey: "SYNC_VALID_EXCEPTION",
      kind: "opened",
      severity: "P1",
      summary: "valid summary",
    }], "2026-08-28T00:00:00.000Z")[0]!;
    const validName = notificationOutboxPropertyName(valid.notificationId, context);
    const corruptName = `NOTIFICATION_OUTBOX_JSON:corrupt:${context}`;
    properties.setProperty(validName, serializeNotificationOutboxItem(valid));
    properties.setProperty(corruptName, "not-json");
    const row: ExceptionRow = {
      exception_key: "SYNC_VALID_EXCEPTION", exception_id: "exception_1", exception_type: "TEST", severity: "P1",
      summary: "valid summary", minhos_member_id: "", ghost_member_id: "", stripe_customer_id: "",
      stripe_subscription_id: "", signal_key: "", first_detected_at: "2026-08-28T00:00:00.000Z",
      last_detected_at: "2026-08-28T00:00:00.000Z", occurrence_count: 1, status: "open", assignee: "",
      resolution: "", resolved_at: "", suppressed_until: "", last_notified_at: "", related_sync_run_id: "run",
    };
    const sendMail = vi.fn(() => { expect(held).toBe(true); });
    const repository = {
      read: vi.fn((name: string) => name === "50_Exceptions" ? [row] : []),
      upsert: vi.fn(),
    } as unknown as SheetsRepository;
    const service = new SyncService({
      config: config(), properties, repository,
      coordinator: {} as RunCoordinator, ghost: {} as GhostAdminClient, stripe: {} as StripeReadOnlyClient,
      now: () => new Date("2026-08-28T00:00:00.000Z"), uuid: () => "uuid", sendMail, setRetryDeadline: vi.fn(),
    });

    (service as unknown as { flushPendingNotifications: (nowIso: string) => void })
      .flushPendingNotifications("2026-08-28T00:00:00.000Z");

    expect(sendMail).toHaveBeenCalledOnce();
    expect(properties.getProperty(corruptName)).toBeNull();
    expect(Object.keys(properties.getProperties())
      .filter((name) => name.startsWith(NOTIFICATION_OUTBOX_QUARANTINE_PROPERTY_PREFIX))).toHaveLength(1);
    expect(repository.upsert).toHaveBeenCalledWith("50_Exceptions", [expect.objectContaining({
      exception_key: "SYNC_VALID_EXCEPTION", last_notified_at: "2026-08-28T00:00:00.000Z",
    })]);
    expect(properties.getProperty(validName)).toBeNull();
    expect(held).toBe(false);
  });
});

function invalidCursorInspection(reason: SyncCursorQuarantineReason): SyncCursorInspection {
  return {
    status: "invalid",
    snapshot: { kind: "sync_cursor_snapshot" },
    sourceHash: "fnv1a-00000000",
    reason,
  };
}

function absentCursorInspection(): SyncCursorInspection {
  return { status: "absent", snapshot: { kind: "sync_cursor_snapshot" } };
}

function incompatibleCursorJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    contextFingerprint: "old_context",
    runId: "run_old",
    requestedRunType: "nightly",
    phase: "refunds",
    startedAt: "2026-08-27T00:00:00.000Z",
    stats: { ghostPages: 1, ghostRecords: 1, stripePages: 1, stripeRecords: 1, billingPages: 0, billingRecords: 0 },
  });
}

function stubScriptLock(): void {
  vi.stubGlobal("LockService", {
    getScriptLock: () => ({
      tryLock: () => true,
      waitLock: () => undefined,
      releaseLock: () => undefined,
    }),
  });
}

function repositoryWriteSpies() {
  return {
    upsert: vi.fn(),
    replace: vi.fn(),
    appendSyncLog: vi.fn(),
    writeDashboard: vi.fn(),
    upsertOwnedRowsInPlace: vi.fn(),
  };
}

function trackedProperties(initial: Record<string, string>) {
  const state: Record<string, string> = { ...initial };
  const setProperty = vi.fn((name: string, value: string) => { state[name] = value; return undefined; });
  const deleteProperty = vi.fn((name: string) => { delete state[name]; return undefined; });
  const properties = {
    getProperty: vi.fn((name: string) => state[name] ?? null),
    getProperties: vi.fn(() => ({ ...state })),
    setProperty,
    deleteProperty,
  } as unknown as GoogleAppsScript.Properties.Properties;
  return { properties, setProperty, deleteProperty, snapshot: () => ({ ...state }) };
}

function config(): SyncConfig {
  return {
    spreadsheetId: "sheet", ghostAdminUrl: "https://example.invalid", ghostSiteId: "site", ghostAcceptVersion: "v5.0",
    stripeAccountId: "acct", stripeApiVersion: "2025-02-24.acacia", livemode: false,
    stripePriceIds: new Set(["price"]), stripeProductIds: new Set(["product"]),
    notificationEmail: "ops@example.invalid", backupFolderId: "folder", backupRetentionDays: 35,
    backupMonthlyRetentionDays: 730, maxRuntimeMs: 270000, watermarkOverlapSeconds: 172800,
    schemaVersion: 1, codeVersion: "0.1.0",
  };
}

function fakeProperties(): GoogleAppsScript.Properties.Properties {
  const state: Record<string, string> = {};
  return {
    getProperty: vi.fn((name: string) => state[name] ?? null),
    setProperty: vi.fn((name: string, value: string) => { state[name] = value; return undefined; }),
    deleteProperty: vi.fn((name: string) => { delete state[name]; return undefined; }),
    getProperties: vi.fn(() => ({ ...state })),
  } as unknown as GoogleAppsScript.Properties.Properties;
}
