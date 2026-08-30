import type { SyncConfig } from "../config";
import type { SyncCursor } from "./types";
import { normalizeGhostAdminUrl } from "./url-normalization";
import { stableHash, stableStringify } from "./values";

export function syncContextFingerprint(config: SyncConfig): string {
  return stableHash({
    spreadsheetId: config.spreadsheetId,
    ghostAdminUrl: normalizeGhostAdminUrl(config.ghostAdminUrl),
    ghostSiteId: config.ghostSiteId,
    ghostAcceptVersion: config.ghostAcceptVersion,
    stripeAccountId: config.stripeAccountId,
    livemode: config.livemode,
    stripePriceIds: [...config.stripePriceIds].sort(),
    stripeProductIds: [...config.stripeProductIds].sort(),
    schemaVersion: config.schemaVersion,
    codeVersion: config.codeVersion,
  });
}

export function environmentMarker(config: SyncConfig): string {
  return stableStringify({
    ghostSiteId: config.ghostSiteId,
    stripeAccountId: config.stripeAccountId,
    livemode: config.livemode,
  });
}

/**
 * Stable property namespace for one external environment. Allowlist/schema/
 * code changes intentionally do not alter this key, so an incompatible old
 * cursor is found, quarantined, and cleared instead of becoming an orphan.
 */
export function environmentNamespace(config: SyncConfig): string {
  return stableHash({
    spreadsheetId: config.spreadsheetId,
    ghostAdminUrl: normalizeGhostAdminUrl(config.ghostAdminUrl),
    ghostSiteId: config.ghostSiteId,
    ghostAcceptVersion: config.ghostAcceptVersion,
    stripeAccountId: config.stripeAccountId,
    livemode: config.livemode,
  });
}

export function assertCursorFingerprint(cursor: SyncCursor, expected: string): void {
  if (!cursor.contextFingerprint || cursor.contextFingerprint !== expected) {
    throw new Error("SYNC_CONTEXT_FINGERPRINT_MISMATCH");
  }
}

export function validateSyncCursor(
  value: unknown,
  expected: { contextFingerprint: string; schemaVersion: number },
): SyncCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_SYNC_CURSOR:not_object");
  const cursor = value as Partial<SyncCursor>;
  const allowedCursorKeys = new Set([
    "schemaVersion", "contextFingerprint", "runId", "requestedRunType", "phase", "ghostPage",
    "stripeStartingAfter", "stripeCreatedGte", "trackedSignalAfterKey", "reconcileInvoiceAfterKey",
    "reconcileTombstoneCommit", "startedAt", "attempts", "stats",
  ]);
  if (Object.keys(cursor).some((key) => !allowedCursorKeys.has(key))) {
    throw new Error("INVALID_SYNC_CURSOR:fields");
  }
  if (!Number.isInteger(cursor.schemaVersion) || cursor.schemaVersion! < 1 || cursor.schemaVersion !== expected.schemaVersion) {
    throw new Error("INVALID_SYNC_CURSOR:schema_version");
  }
  if (cursor.contextFingerprint !== expected.contextFingerprint) throw new Error("SYNC_CONTEXT_FINGERPRINT_MISMATCH");
  if (typeof cursor.runId !== "string" || !cursor.runId) throw new Error("INVALID_SYNC_CURSOR:run_id");
  if (!cursor.requestedRunType || !["hourly", "nightly", "manual"].includes(cursor.requestedRunType)) {
    throw new Error("INVALID_SYNC_CURSOR:run_type");
  }
  const phases = cursor.requestedRunType === "hourly"
    ? ["account", "stripe_subscriptions", "ghost_members", "reconcile"]
    : ["account", "stripe_subscriptions", "ghost_members", "open_invoices", "refunds", "disputes", "tracked_signals", "reconcile"];
  if (typeof cursor.phase !== "string" || !phases.includes(cursor.phase)) throw new Error("INVALID_SYNC_CURSOR:phase");
  if (typeof cursor.startedAt !== "string" || !Number.isFinite(Date.parse(cursor.startedAt))) {
    throw new Error("INVALID_SYNC_CURSOR:started_at");
  }
  if (cursor.ghostPage !== undefined && (!Number.isInteger(cursor.ghostPage) || cursor.ghostPage < 1)) {
    throw new Error("INVALID_SYNC_CURSOR:ghost_page");
  }
  if (cursor.stripeStartingAfter !== undefined &&
    (typeof cursor.stripeStartingAfter !== "string" || !cursor.stripeStartingAfter)) {
    throw new Error("INVALID_SYNC_CURSOR:stripe_cursor");
  }
  if (cursor.stripeCreatedGte !== undefined &&
    cursor.stripeCreatedGte !== null &&
    (!Number.isSafeInteger(cursor.stripeCreatedGte) || cursor.stripeCreatedGte < 0)) {
    throw new Error("INVALID_SYNC_CURSOR:stripe_created_gte");
  }
  if (cursor.trackedSignalAfterKey !== undefined &&
    (typeof cursor.trackedSignalAfterKey !== "string" || !cursor.trackedSignalAfterKey)) {
    throw new Error("INVALID_SYNC_CURSOR:tracked_signal_cursor");
  }
  if (cursor.reconcileInvoiceAfterKey !== undefined &&
    (typeof cursor.reconcileInvoiceAfterKey !== "string" || !cursor.reconcileInvoiceAfterKey)) {
    throw new Error("INVALID_SYNC_CURSOR:reconcile_invoice_cursor");
  }
  if (cursor.reconcileTombstoneCommit !== undefined) {
    const commit = cursor.reconcileTombstoneCommit;
    if (!commit || typeof commit !== "object" || Array.isArray(commit) ||
      Object.keys(commit).some((key) =>
        !["table", "state", "baseTombstoned", "deltaTombstoned"].includes(key)
      ) ||
      !["members", "subscriptions", "grants"].includes(commit.table) ||
      !["pending", "committed"].includes(commit.state) ||
      !Number.isSafeInteger(commit.baseTombstoned) || commit.baseTombstoned < 0 ||
      !Number.isSafeInteger(commit.deltaTombstoned) || commit.deltaTombstoned < 0) {
      throw new Error("INVALID_SYNC_CURSOR:reconcile_tombstone_commit");
    }
  }
  if (cursor.ghostPage !== undefined && cursor.phase !== "ghost_members") {
    throw new Error("INVALID_SYNC_CURSOR:ghost_page_phase");
  }
  const stripeCursorPhases = new Set(["stripe_subscriptions", "open_invoices", "refunds", "disputes"]);
  if (cursor.stripeStartingAfter !== undefined && !stripeCursorPhases.has(cursor.phase)) {
    throw new Error("INVALID_SYNC_CURSOR:stripe_cursor_phase");
  }
  const stripeItemCursorPhases = new Set(["refunds", "disputes"]);
  if (cursor.stripeCreatedGte !== undefined && !stripeItemCursorPhases.has(cursor.phase)) {
    throw new Error("INVALID_SYNC_CURSOR:stripe_created_gte_phase");
  }
  if (cursor.stripeCreatedGte === null && cursor.phase !== "disputes") {
    throw new Error("INVALID_SYNC_CURSOR:stripe_created_gte_value");
  }
  if (cursor.trackedSignalAfterKey !== undefined && cursor.phase !== "tracked_signals") {
    throw new Error("INVALID_SYNC_CURSOR:tracked_signal_cursor_phase");
  }
  if (cursor.reconcileInvoiceAfterKey !== undefined &&
    (cursor.phase !== "reconcile" || cursor.requestedRunType === "hourly")) {
    throw new Error("INVALID_SYNC_CURSOR:reconcile_invoice_cursor_phase");
  }
  if (cursor.reconcileTombstoneCommit !== undefined && cursor.phase !== "reconcile") {
    throw new Error("INVALID_SYNC_CURSOR:reconcile_tombstone_commit_phase");
  }
  if (cursor.stats !== undefined) {
    if (!cursor.stats || typeof cursor.stats !== "object" || Array.isArray(cursor.stats)) {
      throw new Error("INVALID_SYNC_CURSOR:stats");
    }
    const requiredStatKeys = [
      "ghostPages", "ghostRecords", "stripePages", "stripeRecords", "billingPages", "billingRecords",
    ] as const;
    const optionalStatKeys = ["inserted", "updated", "unchanged", "tombstoned"] as const;
    const allowedStatKeys = new Set<string>([...requiredStatKeys, ...optionalStatKeys]);
    const statRecord = cursor.stats as unknown as Record<string, unknown>;
    const invalidRequired = requiredStatKeys.some((key) =>
      typeof statRecord[key] !== "number" || !Number.isInteger(statRecord[key]) || (statRecord[key] as number) < 0,
    );
    const invalidOptional = optionalStatKeys.some((key) =>
      statRecord[key] !== undefined &&
      (typeof statRecord[key] !== "number" || !Number.isInteger(statRecord[key]) || (statRecord[key] as number) < 0),
    );
    if (invalidRequired || invalidOptional || Object.keys(statRecord).some((key) => !allowedStatKeys.has(key))) {
      throw new Error("INVALID_SYNC_CURSOR:stats");
    }
  }
  if (cursor.reconcileTombstoneCommit !== undefined) {
    const commit = cursor.reconcileTombstoneCommit;
    const expectedTombstoned = commit.state === "pending"
      ? commit.baseTombstoned
      : commit.baseTombstoned + commit.deltaTombstoned;
    if ((cursor.stats?.tombstoned ?? 0) !== expectedTombstoned) {
      throw new Error("INVALID_SYNC_CURSOR:reconcile_tombstone_commit_stats");
    }
  }
  if (cursor.attempts !== undefined && (!Array.isArray(cursor.attempts) || cursor.attempts.length > 50 ||
    cursor.attempts.some((attempt) =>
      !attempt ||
      typeof attempt !== "object" ||
      Array.isArray(attempt) ||
      Object.keys(attempt).some((key) => key !== "startedAt" && key !== "entrypoint") ||
      typeof attempt.startedAt !== "string" ||
      !Number.isFinite(Date.parse(attempt.startedAt)) ||
      !["hourly", "nightly", "manual", "resume"].includes(attempt.entrypoint)
    ))) {
    throw new Error("INVALID_SYNC_CURSOR:attempts");
  }
  return cursor as SyncCursor;
}
