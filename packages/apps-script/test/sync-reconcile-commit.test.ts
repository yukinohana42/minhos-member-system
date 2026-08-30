import { afterEach, describe, expect, it, vi } from "vitest";
import type { GhostAdminClient } from "../src/adapters/ghost-admin-client";
import { RunCoordinator } from "../src/adapters/run-coordination";
import type { SheetsRepository } from "../src/adapters/sheets-repository";
import type { StripeReadOnlyClient } from "../src/adapters/stripe-client";
import type { SyncConfig } from "../src/config";
import { subscriptionRowKey } from "../src/domain/keys";
import { syncContextFingerprint } from "../src/domain/sync-context";
import type {
  AccessGrantRow,
  BillingSignalRow,
  ExceptionRow,
  MemberRow,
  SheetRecord,
  SubscriptionRow,
  SyncCursor,
} from "../src/domain/types";
import { SyncService } from "../src/sync/sync-service";

const NOW = new Date("2026-08-30T00:00:00.000Z");

afterEach(() => vi.unstubAllGlobals());

describe("reconcile tombstone commit recovery", () => {
  it.each([
    ["members", "10_Members"],
    ["subscriptions", "20_Subscriptions"],
    ["grants", "21_AccessGrants"],
  ] as const)(
    "replays a %s replace after its committed-cursor write fails without losing or double-counting stats",
    (table, sheetName) => {
      stubExclusiveScriptLock();
      const syncConfig = config();
      const namespace = `reconcile_${table}`;
      const cursorProperty = `SYNC_CURSOR_JSON:${namespace}`;
      const initialCursor = reconcileCursor(syncConfig);
      const properties = failingCursorProperties(cursorProperty, initialCursor, table);
      const coordinator = new RunCoordinator(properties.properties, 360_000, undefined, namespace);
      const scheduleResume = vi.spyOn(coordinator, "scheduleResume").mockImplementation(() => undefined);
      const claim = vi.spyOn(coordinator, "claim");
      const writeCursor = vi.spyOn(coordinator, "writeCursor");
      const clearCursor = vi.spyOn(coordinator, "clearCursor");
      const release = vi.spyOn(coordinator, "release");
      const store = reconcileStore(table);
      const repository = repositoryFixture(store);
      const stripe = {
        getAccount: vi.fn(() => ({ id: "acct" })),
        retrieveProduct: vi.fn((id: string) => ({ id })),
        retrievePrice: vi.fn((id: string) => ({ id, product: "product" })),
      } as unknown as StripeReadOnlyClient;
      let uuidSequence = 0;
      const service = new SyncService({
        config: syncConfig,
        properties: properties.properties,
        repository: repository.repository,
        coordinator,
        ghost: {} as GhostAdminClient,
        stripe,
        now: () => new Date(NOW),
        uuid: () => `uuid_${++uuidSequence}`,
        sendMail: vi.fn(),
        setRetryDeadline: vi.fn(),
      });

      expect(() => service.run("resume")).not.toThrow();

      const pending = JSON.parse(properties.get(cursorProperty) ?? "{}") as SyncCursor;
      expect(properties.didFail()).toBe(true);
      expect(pending.reconcileTombstoneCommit).toEqual({
        table,
        state: "pending",
        baseTombstoned: 0,
        deltaTombstoned: 1,
      });
      expect(pending.stats?.tombstoned ?? 0).toBe(0);
      expect(scheduleResume).toHaveBeenCalledOnce();
      expect(clearCursor).not.toHaveBeenCalled();
      expect(repository.appendSyncLog).not.toHaveBeenCalled();
      expect(properties.get("SYNC_RUN_LEASE_JSON")).toBeNull();

      expect(() => service.run("resume")).not.toThrow();

      expect(repository.replace.mock.calls.filter(([name]) => name === sheetName)).toHaveLength(2);
      expect(tombstonedSource(store, table)).toBe(false);
      expect(repository.appendSyncLog).toHaveBeenCalledOnce();
      const completedLog = repository.appendSyncLog.mock.calls[0]![0] as Record<string, unknown>;
      expect(completedLog.completed).toBe(true);
      expect(JSON.parse(String(completedLog.counts))).toMatchObject({ tombstoned: 1 });
      expect(properties.get(cursorProperty)).toBeNull();
      expect(clearCursor).toHaveBeenCalledOnce();

      const owners = claim.mock.calls.map((call) => String(call[2]));
      expect(owners).toHaveLength(2);
      expect(owners[0]).not.toBe(owners[1]);
      const secondClaimOrder = claim.mock.invocationCallOrder[1]!;
      writeCursor.mock.calls.forEach((call, index) => {
        const expectedOwner = writeCursor.mock.invocationCallOrder[index]! < secondClaimOrder
          ? owners[0]
          : owners[1];
        expect(call[1]).toBe(expectedOwner);
      });
      expect(clearCursor).toHaveBeenCalledWith(initialCursor.runId, owners[1]);
      expect(release.mock.calls.map((call) => call[1])).toEqual(owners);
    },
  );
});

interface ReconcileStore {
  members: MemberRow[];
  subscriptions: SubscriptionRow[];
  grants: AccessGrantRow[];
  signals: BillingSignalRow[];
  exceptions: ExceptionRow[];
}

function reconcileStore(table: "members" | "subscriptions" | "grants"): ReconcileStore {
  return {
    members: table === "members" ? [missingMember()] : [],
    subscriptions: table === "subscriptions" ? [missingSubscription()] : [],
    grants: table === "grants" ? [missingGrant()] : [],
    signals: [],
    exceptions: [],
  };
}

function repositoryFixture(store: ReconcileStore): {
  repository: SheetsRepository;
  replace: ReturnType<typeof vi.fn>;
  appendSyncLog: ReturnType<typeof vi.fn>;
} {
  const read = vi.fn((name: string): SheetRecord[] => {
    if (name === "10_Members") return store.members.map((row) => ({ ...row }));
    if (name === "20_Subscriptions") return store.subscriptions.map((row) => ({ ...row }));
    if (name === "21_AccessGrants") return store.grants.map((row) => ({ ...row }));
    if (name === "25_BillingSignals") return store.signals.map((row) => ({ ...row }));
    if (name === "50_Exceptions") return store.exceptions.map((row) => ({ ...row }));
    return [];
  });
  const replace = vi.fn((name: string, rows: SheetRecord[]) => {
    if (name === "10_Members") store.members = rows.map((row) => ({ ...row })) as MemberRow[];
    if (name === "20_Subscriptions") store.subscriptions = rows.map((row) => ({ ...row })) as SubscriptionRow[];
    if (name === "21_AccessGrants") store.grants = rows.map((row) => ({ ...row })) as AccessGrantRow[];
    if (name === "25_BillingSignals") store.signals = rows.map((row) => ({ ...row })) as BillingSignalRow[];
    if (name === "50_Exceptions") store.exceptions = rows.map((row) => ({ ...row })) as ExceptionRow[];
  });
  const upsert = vi.fn((name: string, rows: SheetRecord[]) => {
    if (name === "50_Exceptions") {
      for (const row of rows as ExceptionRow[]) {
        const index = store.exceptions.findIndex((candidate) => candidate.exception_key === row.exception_key);
        if (index < 0) store.exceptions.push({ ...row });
        else store.exceptions[index] = { ...row };
      }
    }
    return { inserted: rows.length, updated: 0, unchanged: 0 };
  });
  const appendSyncLog = vi.fn();
  const repository = {
    preflightEnvironmentMarker: vi.fn(),
    preflightIdentityIntegrity: vi.fn(),
    read,
    replace,
    upsert,
    upsertOwnedRowsInPlace: vi.fn(() => ({ inserted: 0, updated: 0, unchanged: 0 })),
    writeDashboard: vi.fn(),
    appendSyncLog,
  } as unknown as SheetsRepository;
  return { repository, replace, appendSyncLog };
}

function failingCursorProperties(
  cursorProperty: string,
  initialCursor: SyncCursor,
  failTable: "members" | "subscriptions" | "grants",
) {
  const values = new Map<string, string>([[cursorProperty, JSON.stringify(initialCursor)]]);
  let failed = false;
  const setProperty = vi.fn((name: string, value: string) => {
    if (name === cursorProperty && !failed) {
      const cursor = JSON.parse(value) as SyncCursor;
      if (cursor.reconcileTombstoneCommit?.table === failTable &&
        cursor.reconcileTombstoneCommit.state === "committed") {
        failed = true;
        throw new Error("SIMULATED_CURSOR_WRITE_FAILURE");
      }
    }
    values.set(name, value);
    return undefined;
  });
  const properties = {
    getProperty: vi.fn((name: string) => values.get(name) ?? null),
    getProperties: vi.fn(() => Object.fromEntries(values)),
    setProperty,
    deleteProperty: vi.fn((name: string) => { values.delete(name); return undefined; }),
  } as unknown as GoogleAppsScript.Properties.Properties;
  return {
    properties,
    didFail: () => failed,
    get: (name: string) => values.get(name) ?? null,
  };
}

function reconcileCursor(syncConfig: SyncConfig): SyncCursor {
  return {
    schemaVersion: syncConfig.schemaVersion,
    contextFingerprint: syncContextFingerprint(syncConfig),
    runId: "run_reconcile",
    requestedRunType: "nightly",
    phase: "reconcile",
    startedAt: NOW.toISOString(),
    stats: {
      ghostPages: 0,
      ghostRecords: 0,
      stripePages: 0,
      stripeRecords: 0,
      billingPages: 0,
      billingRecords: 0,
    },
  };
}

function tombstonedSource(store: ReconcileStore, table: "members" | "subscriptions" | "grants"): boolean {
  if (table === "members") return store.members[0]!.source_present_ghost;
  if (table === "subscriptions") return store.subscriptions[0]!.source_present_stripe;
  return store.grants[0]!.source_present_ghost;
}

function missingMember(): MemberRow {
  return {
    member_row_key: "ghost:site:gm_missing",
    minhos_member_id: "mm_missing",
    ghost_site_id: "site",
    ghost_member_id: "gm_missing",
    member_uuid: "member_uuid",
    email: "member@example.invalid",
    name: "Member",
    ghost_member_status: "active",
    ghost_access_state: "free",
    tier_ids: "",
    stripe_customer_ids: "",
    stripe_customer_count: 0,
    qualifying_entitlement_count: 0,
    profile_status: "matched",
    ops_flags: "",
    primary_ops_state: "",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    last_synced_at: NOW.toISOString(),
    source_present_ghost: true,
    source_missing_since: "",
    last_seen_ghost_run_id: "run_previous",
    source_record_hash: "hash",
  };
}

function missingSubscription(): SubscriptionRow {
  return {
    subscription_row_key: subscriptionRowKey("acct", false, "sub_missing"),
    environment: "test",
    livemode: false,
    stripe_account_id: "acct",
    stripe_subscription_id: "sub_missing",
    stripe_customer_id: "cus_missing",
    ghost_member_id: "",
    minhos_member_id: "",
    stripe_product_id: "product",
    stripe_price_id: "price",
    ghost_price_id: "",
    ghost_tier_id: "",
    tier_name: "",
    unit_amount_minor: 1000,
    currency: "jpy",
    billing_interval: "month",
    stripe_status: "active",
    ghost_projected_status: "",
    status_match: "missing_ghost_projection",
    collection_method: "charge_automatically",
    pause_collection_behavior: "",
    cancel_at_period_end: false,
    start_date: "",
    current_period_start: "",
    current_period_end: "",
    canceled_at: "",
    ended_at: "",
    latest_invoice_id: "",
    latest_invoice_status: "",
    open_invoice_count: 0,
    last_invoice_paid_at: "",
    last_payment_failure_at: "",
    source_present_stripe: true,
    source_present_ghost: false,
    source_missing_since: "",
    last_seen_stripe_run_id: "run_previous",
    last_seen_ghost_run_id: "",
    last_synced_at: NOW.toISOString(),
  };
}

function missingGrant(): AccessGrantRow {
  return {
    grant_key: "ghost:site:gm_missing:tier_missing:comped",
    minhos_member_id: "mm_missing",
    ghost_member_id: "gm_missing",
    tier_id: "tier_missing",
    grant_kind: "comped",
    starts_at: "",
    expires_at: "",
    grant_reason: "test",
    approved_by: "test",
    source_present_ghost: true,
    source_missing_since: "",
    last_seen_ghost_run_id: "run_previous",
    last_synced_at: NOW.toISOString(),
  };
}

function config(): SyncConfig {
  return {
    spreadsheetId: "sheet",
    ghostAdminUrl: "https://example.invalid",
    ghostSiteId: "site",
    ghostAcceptVersion: "v5.0",
    stripeAccountId: "acct",
    stripeApiVersion: "2025-02-24.acacia",
    livemode: false,
    stripePriceIds: new Set(["price"]),
    stripeProductIds: new Set(["product"]),
    notificationEmail: "ops@example.invalid",
    backupFolderId: "folder",
    backupRetentionDays: 35,
    backupMonthlyRetentionDays: 730,
    maxRuntimeMs: 270_000,
    watermarkOverlapSeconds: 172_800,
    schemaVersion: 1,
    codeVersion: "0.1.0",
  };
}

function stubExclusiveScriptLock(): void {
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
}
