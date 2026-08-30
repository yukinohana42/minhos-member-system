import { describe, expect, it } from "vitest";
import { loadConfig, type SyncConfig } from "../src/config";
import { assertCursorFingerprint, environmentMarker, environmentNamespace, syncContextFingerprint, validateSyncCursor } from "../src/domain/sync-context";
import type { SyncCursor } from "../src/domain/types";

describe("environment configuration boundary", () => {
  it("rejects every STRIPE_LIVEMODE value except exact true or false", () => {
    expect(() => loadConfig(properties({ STRIPE_LIVEMODE: "TRUE" }))).toThrow("STRIPE_LIVEMODE_MUST_BE_TRUE_OR_FALSE");
    expect(() => loadConfig(properties({ STRIPE_LIVEMODE: "0" }))).toThrow("STRIPE_LIVEMODE_MUST_BE_TRUE_OR_FALSE");
    expect(loadConfig(properties({ STRIPE_LIVEMODE: "false" })).livemode).toBe(false);
    expect(() => loadConfig(properties({ MAX_RUNTIME_MS: "300001" }))).toThrow("MAX_RUNTIME_MS_OUT_OF_SAFE_RANGE");
    expect(() => loadConfig(properties({ MAX_RUNTIME_MS: "299999.5" }))).toThrow("MAX_RUNTIME_MS_OUT_OF_SAFE_RANGE");
    expect(loadConfig(properties({ MAX_RUNTIME_MS: "300000" })).maxRuntimeMs).toBe(300000);
  });

  it("fingerprints site/account/environment/allowlists/schema/code independent of set order", () => {
    const first = config();
    const reordered = { ...first, stripePriceIds: new Set(["price_b", "price_a"]) };
    expect(syncContextFingerprint(first)).toBe(syncContextFingerprint(reordered));
    expect(syncContextFingerprint(first)).toBe(syncContextFingerprint({ ...first, ghostAdminUrl: "https://EXAMPLE.invalid:443/" }));
    expect(syncContextFingerprint(first)).not.toBe(syncContextFingerprint({ ...first, stripeAccountId: "acct_other" }));
    expect(syncContextFingerprint(first)).not.toBe(syncContextFingerprint({ ...first, spreadsheetId: "sheet_other" }));
    expect(syncContextFingerprint(first)).not.toBe(syncContextFingerprint({ ...first, ghostAdminUrl: "https://other.invalid" }));
    expect(syncContextFingerprint(first)).not.toBe(syncContextFingerprint({ ...first, ghostAcceptVersion: "v6.0" }));
    expect(environmentMarker(first)).not.toBe(environmentMarker({ ...first, livemode: true }));
    expect(environmentNamespace(first)).toBe(environmentNamespace({ ...first, codeVersion: "next", stripePriceIds: new Set(["other"]) }));
    expect(environmentNamespace(first)).toBe(environmentNamespace({ ...first, ghostAdminUrl: "https://EXAMPLE.invalid:443/" }));
    expect(environmentNamespace(first)).not.toBe(environmentNamespace({ ...first, stripeAccountId: "acct_other" }));
    expect(environmentNamespace(first)).not.toBe(environmentNamespace({ ...first, spreadsheetId: "sheet_other" }));
    expect(environmentNamespace(first)).not.toBe(environmentNamespace({ ...first, ghostAcceptVersion: "v6.0" }));

    const fingerprint = syncContextFingerprint(first);
    const cursor: SyncCursor = {
      schemaVersion: 1, contextFingerprint: fingerprint, runId: "run", requestedRunType: "nightly",
      phase: "ghost_members", startedAt: "2026-08-28T00:00:00.000Z",
    };
    expect(() => assertCursorFingerprint(cursor, fingerprint)).not.toThrow();
    expect(() => assertCursorFingerprint(cursor, "different")).toThrow("SYNC_CONTEXT_FINGERPRINT_MISMATCH");
    expect(validateSyncCursor(cursor, { contextFingerprint: fingerprint, schemaVersion: 1 })).toEqual(cursor);
    expect(validateSyncCursor({ ...cursor, phase: "refunds", stripeStartingAfter: "re_9", stripeCreatedGte: 1_700_000_000 }, {
      contextFingerprint: fingerprint, schemaVersion: 1,
    })).toMatchObject({ stripeStartingAfter: "re_9", stripeCreatedGte: 1_700_000_000 });
    expect(validateSyncCursor({ ...cursor, requestedRunType: "nightly", phase: "disputes", stripeCreatedGte: null }, {
      contextFingerprint: fingerprint, schemaVersion: 1,
    })).toMatchObject({ stripeCreatedGte: null });
    expect(() => validateSyncCursor({ ...cursor, stripeCreatedGte: 1 }, {
      contextFingerprint: fingerprint, schemaVersion: 1,
    })).toThrow("INVALID_SYNC_CURSOR:stripe_created_gte_phase");
    expect(() => validateSyncCursor({ ...cursor, requestedRunType: "hourly", phase: "reconcile", reconcileInvoiceAfterKey: "stripe:invoice:in_1" }, {
      contextFingerprint: fingerprint, schemaVersion: 1,
    })).toThrow("INVALID_SYNC_CURSOR:reconcile_invoice_cursor_phase");
    expect(() => validateSyncCursor({ ...cursor, phase: "not_a_phase" }, {
      contextFingerprint: fingerprint, schemaVersion: 1,
    })).toThrow("INVALID_SYNC_CURSOR:phase");
    expect(() => validateSyncCursor({ ...cursor, contextFingerprint: "different" }, {
      contextFingerprint: fingerprint, schemaVersion: 1,
    })).toThrow("SYNC_CONTEXT_FINGERPRINT_MISMATCH");
    expect(() => validateSyncCursor({ ...cursor, unexpected: "field" }, {
      contextFingerprint: fingerprint, schemaVersion: 1,
    })).toThrow("INVALID_SYNC_CURSOR:fields");
    expect(() => validateSyncCursor({ ...cursor, stats: { ghostPages: 1 } }, {
      contextFingerprint: fingerprint, schemaVersion: 1,
    })).toThrow("INVALID_SYNC_CURSOR:stats");
    const durableStats = {
      ghostPages: 1, ghostRecords: 2, stripePages: 3, stripeRecords: 4,
      billingPages: 5, billingRecords: 6, tombstoned: 7,
    };
    expect(validateSyncCursor({ ...cursor, stats: durableStats }, {
      contextFingerprint: fingerprint, schemaVersion: 1,
    })).toMatchObject({ stats: durableStats });
    for (const tombstoned of [-1, 1.5, "7"] as const) {
      expect(() => validateSyncCursor({ ...cursor, stats: { ...durableStats, tombstoned } }, {
        contextFingerprint: fingerprint, schemaVersion: 1,
      })).toThrow("INVALID_SYNC_CURSOR:stats");
    }
    const pendingReconcileCommit = {
      table: "subscriptions" as const,
      state: "pending" as const,
      baseTombstoned: 7,
      deltaTombstoned: 2,
    };
    expect(validateSyncCursor({
      ...cursor,
      phase: "reconcile",
      stats: durableStats,
      reconcileTombstoneCommit: pendingReconcileCommit,
    }, { contextFingerprint: fingerprint, schemaVersion: 1 })).toMatchObject({
      reconcileTombstoneCommit: pendingReconcileCommit,
    });
    expect(validateSyncCursor({
      ...cursor,
      phase: "reconcile",
      stats: { ...durableStats, tombstoned: 9 },
      reconcileTombstoneCommit: { ...pendingReconcileCommit, state: "committed" },
    }, { contextFingerprint: fingerprint, schemaVersion: 1 })).toMatchObject({
      stats: expect.objectContaining({ tombstoned: 9 }),
    });
    expect(() => validateSyncCursor({
      ...cursor,
      phase: "reconcile",
      stats: durableStats,
      reconcileTombstoneCommit: { ...pendingReconcileCommit, state: "committed" },
    }, { contextFingerprint: fingerprint, schemaVersion: 1 }))
      .toThrow("INVALID_SYNC_CURSOR:reconcile_tombstone_commit_stats");
    expect(() => validateSyncCursor({
      ...cursor,
      stats: durableStats,
      reconcileTombstoneCommit: pendingReconcileCommit,
    }, { contextFingerprint: fingerprint, schemaVersion: 1 }))
      .toThrow("INVALID_SYNC_CURSOR:reconcile_tombstone_commit_phase");
    expect(() => validateSyncCursor({ ...cursor, trackedSignalAfterKey: "stripe:refund:re_1" }, {
      contextFingerprint: fingerprint, schemaVersion: 1,
    })).toThrow("INVALID_SYNC_CURSOR:tracked_signal_cursor_phase");
  });
});

function properties(overrides: Record<string, string>): GoogleAppsScript.Properties.Properties {
  const values: Record<string, string> = {
    SPREADSHEET_ID: "sheet", GHOST_ADMIN_URL: "https://example.invalid", GHOST_SITE_ID: "site",
    STRIPE_ACCOUNT_ID: "acct", STRIPE_API_VERSION: "2025-02-24.acacia", STRIPE_LIVEMODE: "false",
    STRIPE_PRICE_ALLOWLIST: "price", STRIPE_PRODUCT_ALLOWLIST: "prod", OPS_NOTIFICATION_EMAIL: "ops@example.invalid",
    BACKUP_FOLDER_ID: "folder", ...overrides,
  };
  return { getProperty: (name: string) => values[name] ?? null } as GoogleAppsScript.Properties.Properties;
}

function config(): SyncConfig {
  return {
    spreadsheetId: "sheet", ghostAdminUrl: "https://example.invalid", ghostSiteId: "site", ghostAcceptVersion: "v5.0",
    stripeAccountId: "acct", stripeApiVersion: "2025-02-24.acacia", livemode: false,
    stripePriceIds: new Set(["price_a", "price_b"]), stripeProductIds: new Set(["prod"]),
    notificationEmail: "ops@example.invalid", backupFolderId: "folder", backupRetentionDays: 35,
    backupMonthlyRetentionDays: 730, maxRuntimeMs: 270000, watermarkOverlapSeconds: 172800,
    schemaVersion: 1, codeVersion: "0.1.0",
  };
}
