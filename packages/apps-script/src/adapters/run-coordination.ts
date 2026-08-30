import { canClearLease, createLease, isLeaseActive, isLeaseHolder } from "../domain/lease";
import { assertSafePropertyStoreWrites } from "../domain/property-quota";
import { shouldCreateResumeTrigger } from "../domain/resume-trigger";
import { validateSyncCursor } from "../domain/sync-context";
import { assertExecutingTrigger, type ManagedTriggerSpec, type TriggerDescriptor } from "../domain/trigger-integrity";
import type { RunLease, SyncCursor } from "../domain/types";
import { stableHash } from "../domain/values";

const LEASE_PROPERTY = "SYNC_RUN_LEASE_JSON";
const CURSOR_PROPERTY = "SYNC_CURSOR_JSON";
const CURSOR_QUARANTINE_PROPERTY = "SYNC_CURSOR_QUARANTINE_JSON";

export class RunLeaseFenced extends Error {
  constructor() {
    super("SYNC_RUN_LEASE_FENCED");
  }
}

export type SyncCursorQuarantineReason =
  | "INVALID_SYNC_CURSOR_JSON"
  | "INVALID_SYNC_CURSOR_SCHEMA"
  | "SYNC_CONTEXT_FINGERPRINT_MISMATCH";

/**
 * An execution-local, opaque capture of one cursor property value. The raw
 * value lives only in the private WeakMap below and cannot be logged by a
 * caller that receives an inspection result.
 */
export interface SyncCursorSnapshot {
  readonly kind: "sync_cursor_snapshot";
}

interface SyncCursorSnapshotValue {
  readonly contextNamespace: string;
  readonly raw: string | null;
}

const cursorSnapshotValues = new WeakMap<SyncCursorSnapshot, SyncCursorSnapshotValue>();

export type SyncCursorInspection =
  | { readonly status: "absent"; readonly snapshot: SyncCursorSnapshot }
  | { readonly status: "valid"; readonly cursor: SyncCursor; readonly snapshot: SyncCursorSnapshot }
  | InvalidSyncCursorInspection;

export interface InvalidSyncCursorInspection {
  readonly status: "invalid";
  readonly snapshot: SyncCursorSnapshot;
  readonly sourceHash: string;
  readonly reason: SyncCursorQuarantineReason;
}

export class RunCoordinator {
  constructor(
    private readonly properties: GoogleAppsScript.Properties.Properties,
    private readonly leaseTtlMs = 360_000,
    private readonly executingTriggerUid?: string,
    private readonly contextNamespace = "default",
  ) {}

  claim(
    runId: string,
    nowMs: number,
    ownerId = runId,
    cursorInspection?: SyncCursorInspection,
  ): void {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5_000)) throw new Error("SYNC_LOCK_BUSY");
    try {
      if (cursorInspection) {
        if (cursorInspection.status === "valid" && cursorInspection.cursor.runId !== runId) {
          throw new RunLeaseFenced();
        }
        this.assertCursorSnapshot(cursorInspection.snapshot);
      }
      const lease = this.readLease(new Date(nowMs));
      if (isLeaseActive(lease, nowMs)) throw new Error("SYNC_RUN_ALREADY_ACTIVE");
      this.setProperty(LEASE_PROPERTY, JSON.stringify(createLease(runId, nowMs, this.leaseTtlMs, ownerId)));
    } finally {
      lock.releaseLock();
    }
  }

  renew(runId: string, nowMs: number, ownerId = runId): void {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5_000)) throw new Error("SYNC_LOCK_BUSY");
    try {
      const lease = this.readLease(new Date(nowMs));
      // Renewal is never an acquisition path. Once a lease is absent,
      // expired, or owned by another invocation, only claim() may establish
      // the next owner. This prevents a timed-out execution from reviving
      // itself after a same-run takeover has completed and released.
      if (!isLeaseActive(lease, nowMs) || !isLeaseHolder(lease, runId, ownerId)) {
        throw new RunLeaseFenced();
      }
      this.setProperty(LEASE_PROPERTY, JSON.stringify(createLease(runId, nowMs, this.leaseTtlMs, ownerId)));
    } finally {
      lock.releaseLock();
    }
  }

  release(runId: string, ownerId = runId): void {
    const lock = LockService.getScriptLock();
    lock.waitLock(5_000);
    try {
      if (canClearLease(this.readLease(), runId, ownerId)) this.properties.deleteProperty(LEASE_PROPERTY);
    } finally {
      lock.releaseLock();
    }
  }

  assertOwner(runId: string, ownerId = runId): void {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5_000)) throw new Error("SYNC_LOCK_BUSY");
    try {
      this.requireLeaseHolder(runId, ownerId);
    } finally {
      lock.releaseLock();
    }
  }

  /**
   * Read and validate the cursor without changing Script Properties. An
   * invalid result remains durable until a fenced caller explicitly commits
   * its quarantine after every repository preflight has succeeded.
   */
  inspectCursor(expected: { contextFingerprint: string; schemaVersion: number }): SyncCursorInspection {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5_000)) throw new Error("SYNC_LOCK_BUSY");
    try {
      const raw = this.properties.getProperty(this.cursorProperty());
      const snapshot = this.captureCursorSnapshot(raw);
      if (!raw) return { status: "absent", snapshot };
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return {
          status: "invalid",
          snapshot,
          sourceHash: stableHash(raw),
          reason: "INVALID_SYNC_CURSOR_JSON",
        };
      }
      try {
        return { status: "valid", cursor: validateSyncCursor(parsed, expected), snapshot };
      } catch (error) {
        return {
          status: "invalid",
          snapshot,
          sourceHash: stableHash(raw),
          reason: cursorValidationReason(error),
        };
      }
    } finally {
      lock.releaseLock();
    }
  }

  /**
   * Persist quarantine metadata before deleting exactly the invalid cursor
   * that was inspected. A changed cursor is left untouched for its owner and
   * reported as an uncommitted snapshot.
   */
  commitCursorQuarantine(
    inspection: InvalidSyncCursorInspection,
    runId: string,
    ownerId = runId,
    quarantinedAt = new Date(),
  ): void {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5_000)) throw new Error("SYNC_LOCK_BUSY");
    try {
      this.requireLeaseHolder(runId, ownerId);
      const source = this.cursorSnapshotValue(inspection.snapshot);
      if (source.raw === null || stableHash(source.raw) !== inspection.sourceHash) throw new RunLeaseFenced();
      if (this.properties.getProperty(this.cursorProperty()) !== source.raw) throw new RunLeaseFenced();
      this.setProperty(this.cursorQuarantineProperty(), JSON.stringify({
        quarantined_at: quarantinedAt.toISOString(),
        reason: inspection.reason,
        source_hash: inspection.sourceHash,
      }));
      this.properties.deleteProperty(this.cursorProperty());
    } finally {
      lock.releaseLock();
    }
  }

  writeCursor(cursor: SyncCursor, ownerId = cursor.runId): void {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5_000)) throw new Error("SYNC_LOCK_BUSY");
    try {
      this.requireLeaseHolder(cursor.runId, ownerId);
      this.setProperty(this.cursorProperty(), JSON.stringify(cursor));
    } finally {
      lock.releaseLock();
    }
  }

  clearCursor(runId: string, ownerId = runId): void {
    const lock = LockService.getScriptLock();
    lock.waitLock(5_000);
    try {
      this.requireLeaseHolder(runId, ownerId);
      const raw = this.properties.getProperty(this.cursorProperty());
      if (!raw) return;
      try {
        const cursor = JSON.parse(raw) as Partial<SyncCursor>;
        if (!cursor.runId || cursor.runId === runId) this.properties.deleteProperty(this.cursorProperty());
      } catch {
        this.properties.deleteProperty(this.cursorProperty());
      }
    } finally {
      lock.releaseLock();
    }
  }

  scheduleResume(): void {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5_000)) throw new Error("SYNC_LOCK_BUSY");
    try {
      const handler = "resumeSync";
      const constraint = resumeTriggerSpec();
      const triggers = ScriptApp.getProjectTriggers().map(syncTriggerDescriptor);
      if (!shouldCreateResumeTrigger(triggers, this.executingTriggerUid, handler, constraint)) return;
      const created = ScriptApp.newTrigger(handler).timeBased().after(60_000).create();
      assertExecutingTrigger([syncTriggerDescriptor(created)], created.getUniqueId(), constraint);
    } finally {
      lock.releaseLock();
    }
  }

  private readLease(quarantinedAt = new Date()): RunLease | null {
    const raw = this.properties.getProperty(LEASE_PROPERTY);
    if (!raw) return null;
    try {
      return validateRunLease(JSON.parse(raw) as unknown);
    } catch {
      this.setProperty("SYNC_RUN_LEASE_QUARANTINE_JSON", JSON.stringify({
        quarantined_at: quarantinedAt.toISOString(),
        reason: "INVALID_SYNC_RUN_LEASE",
        source_hash: stableHash(raw),
      }));
      this.properties.deleteProperty(LEASE_PROPERTY);
      return null;
    }
  }

  private captureCursorSnapshot(raw: string | null): SyncCursorSnapshot {
    const snapshot = Object.freeze({ kind: "sync_cursor_snapshot" as const });
    cursorSnapshotValues.set(snapshot, { contextNamespace: this.contextNamespace, raw });
    return snapshot;
  }

  private cursorSnapshotValue(snapshot: SyncCursorSnapshot): SyncCursorSnapshotValue {
    const value = cursorSnapshotValues.get(snapshot);
    if (!value || value.contextNamespace !== this.contextNamespace) throw new RunLeaseFenced();
    return value;
  }

  private assertCursorSnapshot(snapshot: SyncCursorSnapshot): void {
    const expected = this.cursorSnapshotValue(snapshot);
    if (this.properties.getProperty(this.cursorProperty()) !== expected.raw) throw new RunLeaseFenced();
  }

  private requireLeaseHolder(runId: string, ownerId: string): void {
    if (!isLeaseHolder(this.readLease(), runId, ownerId)) throw new RunLeaseFenced();
  }

  private cursorProperty(): string {
    return `${CURSOR_PROPERTY}:${this.contextNamespace}`;
  }

  private cursorQuarantineProperty(): string {
    return `${CURSOR_QUARANTINE_PROPERTY}:${this.contextNamespace}`;
  }

  private setProperty(name: string, value: string): void {
    assertSafePropertyStoreWrites(this.properties.getProperties(), [{ name, value }], "SYNC_COORDINATION_PROPERTY");
    this.properties.setProperty(name, value);
  }
}

function cursorValidationReason(error: unknown): SyncCursorQuarantineReason {
  return error instanceof Error && error.message === "SYNC_CONTEXT_FINGERPRINT_MISMATCH"
    ? "SYNC_CONTEXT_FINGERPRINT_MISMATCH"
    : "INVALID_SYNC_CURSOR_SCHEMA";
}

function resumeTriggerSpec(): ManagedTriggerSpec {
  return {
    handlerFunction: "resumeSync",
    eventType: String(ScriptApp.EventType.CLOCK),
    triggerSource: String(ScriptApp.TriggerSource.CLOCK),
    triggerSourceId: "",
  };
}

function syncTriggerDescriptor(trigger: GoogleAppsScript.Script.Trigger): TriggerDescriptor {
  const sourceId = trigger.getTriggerSourceId();
  return {
    handlerFunction: trigger.getHandlerFunction(),
    uniqueId: trigger.getUniqueId(),
    eventType: String(trigger.getEventType()),
    triggerSource: String(trigger.getTriggerSource()),
    triggerSourceId: sourceId === null || sourceId === undefined ? "" : String(sourceId),
  };
}

export function validateRunLease(value: unknown): RunLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_SYNC_RUN_LEASE:not_object");
  }
  const lease = value as Partial<RunLease>;
  const allowed = new Set(["runId", "ownerId", "expiresAtMs"]);
  if (Object.keys(lease).some((key) => !allowed.has(key))) throw new Error("INVALID_SYNC_RUN_LEASE:fields");
  if (typeof lease.runId !== "string" || !lease.runId) throw new Error("INVALID_SYNC_RUN_LEASE:run_id");
  if (lease.ownerId !== undefined && (typeof lease.ownerId !== "string" || !lease.ownerId)) {
    throw new Error("INVALID_SYNC_RUN_LEASE:owner_id");
  }
  if (!Number.isSafeInteger(lease.expiresAtMs) || lease.expiresAtMs! <= 0) {
    throw new Error("INVALID_SYNC_RUN_LEASE:expires_at");
  }
  return lease as RunLease;
}
