import { afterEach, describe, expect, it, vi } from "vitest";
import type { GhostAdminClient } from "../src/adapters/ghost-admin-client";
import type { SheetsRepository } from "../src/adapters/sheets-repository";
import type { StripeReadOnlyClient } from "../src/adapters/stripe-client";
import type { SyncConfig } from "../src/config";
import type {
  BillingSignalRow,
  ExceptionRow,
  GhostSubscriptionProjection,
  SubscriptionRow,
  SyncCursor,
  StripeDisputeRaw,
  StripeInvoiceRaw,
  StripeRefundRaw,
} from "../src/domain/types";
import { subscriptionRowKey } from "../src/domain/keys";
import { SyncYieldRequested } from "../src/domain/runtime-budget";
import { syncContextFingerprint } from "../src/domain/sync-context";
import { SyncService } from "../src/sync/sync-service";

const FULL_PHASES = [
  "account", "stripe_subscriptions", "ghost_members", "open_invoices", "refunds", "disputes", "tracked_signals", "reconcile",
] as const;
const NOW = new Date("2026-08-28T00:00:00.000Z");

afterEach(() => vi.unstubAllGlobals());

describe("item-granular billing resume", () => {
  it.each(["refunds", "disputes"] as const)(
    "finishes a 100-item %s list over bounded invocations without duplicate or lost ledger rows",
    (kind) => {
      const items = kind === "refunds" ? refunds(100) : disputes(100);
      const store = createStore();
      const listCalls: Array<string | undefined> = [];
      const lowerBounds: Array<number | undefined> = [];
      const stripe = {
        listRefunds: vi.fn((_createdGte: number, startingAfter?: string) => {
          lowerBounds.push(_createdGte);
          listCalls.push(startingAfter);
          return { object: "list", data: afterItem(items as StripeRefundRaw[], startingAfter), has_more: false };
        }),
        listDisputes: vi.fn((_createdGte?: number, startingAfter?: string) => {
          lowerBounds.push(_createdGte);
          listCalls.push(startingAfter);
          return { object: "list", data: afterItem(items as StripeDisputeRaw[], startingAfter), has_more: false };
        }),
      } as unknown as StripeReadOnlyClient;
      const { service, coordinator, properties } = createService(store, stripe);
      const cursor = baseCursor(kind);
      const process = privateService(service);
      let invocations = 0;
      while (cursor.phase === kind) {
        const paused = kind === "refunds"
          ? process.processRefundsPage(cursor, FULL_PHASES, NOW.getTime() + 300_000)
          : process.processDisputesPage(cursor, FULL_PHASES, NOW.getTime() + 300_000);
        invocations += 1;
        expect(invocations).toBeLessThanOrEqual(11);
        if (!paused) break;
      }

      expect(cursor.phase).toBe(kind === "refunds" ? "disputes" : "tracked_signals");
      expect(store.signals.size).toBe(100);
      expect(new Set(store.signals.keys()).size).toBe(100);
      expect([...store.signals.values()].map((row) => row.stripe_object_id).sort())
        .toEqual(items.map((item) => item.id).sort());
      expect(cursor.stats?.billingRecords).toBe(100);
      // A list response is counted once per bounded request segment; records
      // remain exactly-once even though one Stripe page is split across runs.
      expect(cursor.stats?.billingPages).toBe(10);
      expect(coordinator.scheduleResume).toHaveBeenCalledTimes(9);
      expect(coordinator.writeCursor).toHaveBeenCalled();
      expect(properties.getProperty("REFUND_WATERMARK_UNIX:")).toBeNull();
      if (kind === "refunds") {
        expect(Object.keys(properties.getProperties()).some((key) => key.startsWith("REFUND_WATERMARK_UNIX:"))).toBe(true);
      } else {
        expect(Object.keys(properties.getProperties()).some((key) => key.startsWith("DISPUTE_HISTORY_COMPLETE:"))).toBe(true);
      }
      expect(listCalls[0]).toBeUndefined();
      expect(listCalls.slice(1).every((value) => typeof value === "string")).toBe(true);
      expect(listCalls[listCalls.length - 1]).toBe(items[89]!.id);
      if (kind === "refunds") {
        expect(lowerBounds[0]).toEqual(expect.any(Number));
        expect(new Set(lowerBounds).size).toBe(1);
      } else {
        expect(lowerBounds.every((value) => value === undefined)).toBe(true);
      }
    },
  );

  it("refetches 100 unseen open invoices over bounded reconcile invocations and commits each item once", () => {
    const store = createStore();
    const invoices = Array.from({ length: 100 }, (_, index) => invoiceSignal(index + 1));
    for (const row of invoices) store.signals.set(row.signal_key, row);
    const retrieved: string[] = [];
    const stripe = {
      retrieveInvoice: vi.fn((id: string): StripeInvoiceRaw => {
        retrieved.push(id);
        const number = Number(id.slice(3));
        return {
          id,
          status: number % 2 === 0 ? "paid" : "open",
          customer: { id: "cus_current" },
          subscription: { id: "sub_current" },
          amount_due: 1000,
          currency: "jpy",
          created: 1_700_000_000 + number,
          livemode: false,
        };
      }),
    } as unknown as StripeReadOnlyClient;
    const { service, coordinator, repository } = createService(store, stripe);
    const cursor = baseCursor("reconcile");
    const process = privateService(service);
    let invocations = 0;
    while (true) {
      const paused = process.reconcile(cursor, NOW.getTime() + 300_000);
      invocations += 1;
      expect(invocations).toBeLessThanOrEqual(11);
      if (!paused) break;
    }

    expect(invocations).toBe(10);
    expect(retrieved).toHaveLength(100);
    expect(new Set(retrieved).size).toBe(100);
    expect([...store.signals.values()]).toHaveLength(100);
    expect([...store.signals.values()].filter((row) => row.raw_status === "paid" && row.needs_action)).toHaveLength(0);
    expect([...store.signals.values()].filter((row) => row.raw_status === "open" && !row.needs_action)).toHaveLength(0);
    expect(cursor.reconcileInvoiceAfterKey).toBeUndefined();
    expect(cursor.stats?.billingRecords).toBe(100);
    expect(coordinator.scheduleResume).toHaveBeenCalledTimes(9);
    expect(repository.replace).toHaveBeenCalledWith("25_BillingSignals", expect.any(Array));
  });

  it("keeps a durable tombstone count across reconcile yield and clears shared missing state on Ghost reappearance", () => {
    const store = createStore();
    store.subscriptions.push({
      ...validSubscription(),
      ghost_projected_status: "active",
      status_match: "match",
      last_seen_ghost_run_id: "run_previous",
    });
    let expireAfterSubscriptionWrite = false;
    let yieldedOnce = false;
    const now = () => new Date(expireAfterSubscriptionWrite ? NOW.getTime() + 400_000 : NOW.getTime());
    const { service, coordinator, repository } = createService(
      store,
      {} as StripeReadOnlyClient,
      now,
      (sheetName) => {
        if (sheetName === "20_Subscriptions" && !yieldedOnce) {
          yieldedOnce = true;
          expireAfterSubscriptionWrite = true;
        }
      },
    );
    const cursor = baseCursor("reconcile");
    const process = privateService(service);

    expect(() => process.reconcile(cursor, NOW.getTime() + 300_000)).toThrow(SyncYieldRequested);
    expect(store.subscriptions[0]).toMatchObject({
      source_present_ghost: false,
      source_missing_since: NOW.toISOString(),
      ghost_member_id: "gm_current",
      minhos_member_id: "mm_current",
      last_seen_ghost_run_id: "run_previous",
      ghost_projected_status: "",
      status_match: "missing_ghost_projection",
    });
    expect(cursor.stats?.tombstoned).toBe(1);
    expect(coordinator.writeCursor).toHaveBeenCalledWith(expect.objectContaining({
      stats: expect.objectContaining({ tombstoned: 1 }),
    }), expect.any(String));

    expireAfterSubscriptionWrite = false;
    expect(process.reconcile(cursor, NOW.getTime() + 300_000)).toBe(false);
    const missingLog = repository.appendSyncLog.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(JSON.parse(String(missingLog.counts))).toMatchObject({ tombstoned: 1 });

    const reappearCursor = { ...baseCursor("reconcile"), runId: "run_reappear" };
    store.subscriptions[0]!.last_seen_stripe_run_id = reappearCursor.runId;
    const projection: GhostSubscriptionProjection = {
      stripe_subscription_id: "sub_current",
      stripe_customer_id: "cus_current",
      ghost_member_id: "gm_current",
      minhos_member_id: "mm_current",
      ghost_projected_status: "active",
      stripe_price_id: "price",
      ghost_price_id: "ghost_price",
      stripe_product_id: "product",
      ghost_tier_id: "ghost_tier",
      tier_name: "Tier",
      source_present_ghost: true,
      last_seen_ghost_run_id: reappearCursor.runId,
    };
    process.applyGhostProjections([projection], "2026-08-29T00:00:00.000Z", reappearCursor, NOW.getTime() + 300_000);
    expect(store.subscriptions[0]).toMatchObject({
      source_present_ghost: true,
      source_missing_since: "",
      ghost_projected_status: "active",
      status_match: "match",
      last_seen_ghost_run_id: "run_reappear",
    });
    expect(process.reconcile(reappearCursor, NOW.getTime() + 300_000)).toBe(false);
    const reappearedLog = repository.appendSyncLog.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(JSON.parse(String(reappearedLog.counts))).toMatchObject({ tombstoned: 0 });
  });

  it("makes monotonic durable progress across 100 fresh low-runtime Refund invocations", () => {
    const items = refunds(100);
    const store = createStore();
    const requestedAfter: Array<string | undefined> = [];
    const lowerBounds: number[] = [];
    const stripe = {
      listRefunds: vi.fn((createdGte: number, startingAfter?: string) => {
        lowerBounds.push(createdGte);
        requestedAfter.push(startingAfter);
        return { object: "list", data: afterItem(items, startingAfter), has_more: false };
      }),
    } as unknown as StripeReadOnlyClient;
    const cursor = baseCursor("refunds");
    let invocations = 0;

    while (cursor.phase === "refunds") {
      let tick = 0;
      const now = () => new Date(NOW.getTime() + tick++ * 1_000);
      // With a 15-second safety reserve, this 21-second deadline leaves only
      // enough simulated time for a small prefix before the invocation yields.
      const { service } = createService(store, stripe, now);
      let paused = false;
      try {
        paused = privateService(service).processRefundsPage(
          cursor,
          FULL_PHASES,
          NOW.getTime() + 21_000,
        );
      } catch (error) {
        // The public run() boundary converts this signal into a durable pause.
        // Calling the private phase method directly keeps the fixture small,
        // so emulate only that outer catch here.
        expect(error).toBeInstanceOf(SyncYieldRequested);
        paused = true;
      }
      invocations += 1;
      if (!paused) break;
    }

    expect(invocations).toBeGreaterThan(10);
    expect(invocations).toBeLessThanOrEqual(101);
    expect(store.signals.size).toBe(100);
    expect(cursor.stats?.billingRecords).toBe(100);
    expect(cursor.phase).toBe("disputes");
    expect(requestedAfter[0]).toBeUndefined();
    expect(requestedAfter).toHaveLength(invocations);
    expect(new Set(requestedAfter.slice(1)).size).toBe(requestedAfter.length - 1);
    const itemIndex = new Map(items.map((item, index) => [item.id, index]));
    const requestedIndexes = requestedAfter.slice(1).map((id) => itemIndex.get(id!) ?? -1);
    expect(requestedIndexes.every((value, index) => index === 0 || value > requestedIndexes[index - 1]!)).toBe(true);
    expect(requestedIndexes[requestedIndexes.length - 1]).toBeGreaterThanOrEqual(items.length - 2);
    expect(new Set(lowerBounds).size).toBe(1);
  });

  it("keeps an unmatched finding idempotent when a Sheet write succeeds before cursor persistence fails", () => {
    const store = createStore();
    const matched = refunds(1)[0]!;
    const item: StripeRefundRaw = {
      ...matched,
      charge: typeof matched.charge === "object" && matched.charge
        ? { ...matched.charge, invoice: null }
        : null,
    };
    const stripe = {
      listRefunds: vi.fn(() => ({ object: "list", data: [item], has_more: false })),
    } as unknown as StripeReadOnlyClient;
    const { service, coordinator } = createService(store, stripe);
    const cursor = baseCursor("refunds");
    const process = privateService(service);
    const durableCursor = JSON.parse(JSON.stringify(cursor)) as SyncCursor;
    coordinator.writeCursor
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error("CURSOR_WRITE_FAILED"); });

    expect(() => process.processRefundsPage(cursor, FULL_PHASES, NOW.getTime() + 300_000)).toThrow("CURSOR_WRITE_FAILED");
    // This fixture cannot resolve a subscription, so the only committed
    // mutation is the quarantine exception. Replay the durable pre-item
    // cursor and confirm occurrence_count does not inflate within the run.
    const replayCursor = durableCursor;
    expect(() => process.processRefundsPage(replayCursor, FULL_PHASES, NOW.getTime() + 300_000)).not.toThrow();
    const unmatched = store.exceptions.find((row) => row.exception_type === "UNMATCHED_BILLING_SIGNAL");
    expect(unmatched).toMatchObject({ occurrence_count: 1, related_sync_run_id: "run_test" });
  });

  it("honors an explicit unbounded Dispute cursor even if the history marker was already written", () => {
    const store = createStore();
    const item = disputes(1)[0]!;
    const createdGte: Array<number | undefined> = [];
    const stripe = {
      listDisputes: vi.fn((lowerBound?: number) => {
        createdGte.push(lowerBound);
        return { object: "list", data: [item], has_more: false };
      }),
    } as unknown as StripeReadOnlyClient;
    const { service, properties } = createService(store, stripe);
    properties.setProperty(`DISPUTE_HISTORY_COMPLETE:${syncContextFingerprint(config())}`, "true");
    const cursor = { ...baseCursor("disputes"), stripeCreatedGte: null };
    const process = privateService(service);

    expect(process.processDisputesPage(cursor, FULL_PHASES, NOW.getTime() + 300_000)).toBe(false);
    expect(createdGte).toEqual([undefined]);
  });

  it("rejects a retrieved Invoice ID mismatch before writing or advancing the cursor", () => {
    const store = createStore();
    const stale = invoiceSignal(1);
    store.signals.set(stale.signal_key, stale);
    const stripe = {
      retrieveInvoice: vi.fn(() => ({
        id: "in_other", status: "paid", customer: { id: "cus_current" }, subscription: { id: "sub_current" },
        amount_due: 1000, currency: "jpy", created: 1_700_000_001, livemode: false,
      })),
    } as unknown as StripeReadOnlyClient;
    const { service, repository } = createService(store, stripe);
    const cursor = baseCursor("reconcile");
    const process = privateService(service);

    expect(() => process.reconcile(cursor, NOW.getTime() + 300_000)).toThrow("STRIPE_OBJECT_ID_MISMATCH:invoice");
    expect(repository.upsert).not.toHaveBeenCalledWith("25_BillingSignals", expect.any(Array));
    expect(cursor.reconcileInvoiceAfterKey).toBeUndefined();
  });
});

interface Store {
  signals: Map<string, BillingSignalRow>;
  exceptions: ExceptionRow[];
  subscriptions: SubscriptionRow[];
}

interface CoordinatorMock {
  renew: ReturnType<typeof vi.fn>;
  writeCursor: ReturnType<typeof vi.fn>;
  scheduleResume: ReturnType<typeof vi.fn>;
  clearCursor: ReturnType<typeof vi.fn>;
}

function createService(
  store: Store,
  stripe: StripeReadOnlyClient,
  now: () => Date = () => new Date(NOW),
  onReplace: (sheetName: string) => void = () => undefined,
): {
  service: SyncService;
  coordinator: CoordinatorMock;
  properties: GoogleAppsScript.Properties.Properties;
  repository: {
    read: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    replace: ReturnType<typeof vi.fn>;
    appendSyncLog: ReturnType<typeof vi.fn>;
  };
} {
  vi.stubGlobal("LockService", {
    getScriptLock: () => ({ tryLock: () => true, waitLock: () => undefined, releaseLock: () => undefined }),
  });
  const values: Record<string, string> = {};
  const properties = {
    getProperty: vi.fn((name: string) => values[name] ?? null),
    setProperty: vi.fn((name: string, value: string) => { values[name] = value; return undefined; }),
    deleteProperty: vi.fn((name: string) => { delete values[name]; return undefined; }),
    getProperties: vi.fn(() => ({ ...values })),
  } as unknown as GoogleAppsScript.Properties.Properties;
  const subscription = validSubscription();
  if (!store.subscriptions.length) store.subscriptions.push(subscription);
  const repository = {
    read: vi.fn((name: string) => {
      if (name === "20_Subscriptions") return store.subscriptions.map((row) => ({ ...row }));
      if (name === "25_BillingSignals") return [...store.signals.values()].map((row) => ({ ...row }));
      if (name === "50_Exceptions") return store.exceptions.map((row) => ({ ...row }));
      return [];
    }),
    upsert: vi.fn((name: string, rows: Array<Record<string, unknown>>, ownedColumns?: string[]) => {
      if (name === "20_Subscriptions") {
        for (const row of rows) {
          const key = String(row.subscription_row_key);
          const index = store.subscriptions.findIndex((candidate) => candidate.subscription_row_key === key);
          if (index < 0) {
            store.subscriptions.push({ ...row } as SubscriptionRow);
            continue;
          }
          const next = { ...store.subscriptions[index] } as Record<string, unknown>;
          for (const column of ownedColumns ?? Object.keys(row)) {
            if (column in row) next[column] = row[column] ?? "";
          }
          store.subscriptions[index] = next as SubscriptionRow;
        }
      }
      if (name === "25_BillingSignals") {
        for (const row of rows) store.signals.set(String(row.signal_key), { ...row } as BillingSignalRow);
      }
      if (name === "50_Exceptions") {
        for (const row of rows) {
          const key = String(row.exception_key);
          const index = store.exceptions.findIndex((candidate) => candidate.exception_key === key);
          if (index < 0) store.exceptions.push({ ...row } as ExceptionRow);
          else store.exceptions[index] = { ...row } as ExceptionRow;
        }
      }
      return { inserted: rows.length, updated: 0, unchanged: 0 };
    }),
    replace: vi.fn((name: string, rows: Array<Record<string, unknown>>) => {
      if (name === "25_BillingSignals") {
        store.signals = new Map(rows.map((row) => [String(row.signal_key), { ...row } as BillingSignalRow]));
      }
      if (name === "50_Exceptions") {
        store.exceptions = rows.map((row) => ({ ...row } as ExceptionRow));
      }
      if (name === "20_Subscriptions") {
        store.subscriptions = rows.map((row) => ({ ...row } as SubscriptionRow));
      }
      onReplace(name);
    }),
    writeDashboard: vi.fn(),
    appendSyncLog: vi.fn(),
    preflightEnvironmentMarker: vi.fn(),
    upsertOwnedRowsInPlace: vi.fn(),
  } as unknown as {
    read: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    replace: ReturnType<typeof vi.fn>;
    appendSyncLog: ReturnType<typeof vi.fn>;
  };
  const coordinator: CoordinatorMock = {
    renew: vi.fn(), writeCursor: vi.fn(), scheduleResume: vi.fn(), clearCursor: vi.fn(),
  };
  const service = new SyncService({
    config: config(),
    properties,
    repository: repository as unknown as SheetsRepository,
    coordinator: coordinator as never,
    ghost: {} as GhostAdminClient,
    stripe,
    now,
    uuid: () => "uuid",
    sendMail: vi.fn(),
    setRetryDeadline: vi.fn(),
  });
  return { service, coordinator, properties, repository };
}

function privateService(service: SyncService): {
  processRefundsPage: (cursor: SyncCursor, phases: readonly string[], deadlineMs: number) => boolean;
  processDisputesPage: (cursor: SyncCursor, phases: readonly string[], deadlineMs: number) => boolean;
  reconcile: (cursor: SyncCursor, deadlineMs: number) => boolean;
  applyGhostProjections: (
    projections: GhostSubscriptionProjection[],
    nowIso: string,
    cursor: SyncCursor,
    deadlineMs: number,
  ) => void;
} {
  return service as unknown as {
    processRefundsPage: (cursor: SyncCursor, phases: readonly string[], deadlineMs: number) => boolean;
    processDisputesPage: (cursor: SyncCursor, phases: readonly string[], deadlineMs: number) => boolean;
    reconcile: (cursor: SyncCursor, deadlineMs: number) => boolean;
    applyGhostProjections: (
      projections: GhostSubscriptionProjection[],
      nowIso: string,
      cursor: SyncCursor,
      deadlineMs: number,
    ) => void;
  };
}

function baseCursor(phase: "refunds" | "disputes" | "reconcile"): SyncCursor {
  return {
    schemaVersion: 1,
    contextFingerprint: "test",
    runId: "run_test",
    requestedRunType: "nightly",
    phase,
    startedAt: NOW.toISOString(),
    stats: { ghostPages: 0, ghostRecords: 0, stripePages: 0, stripeRecords: 0, billingPages: 0, billingRecords: 0 },
  };
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

function createStore(): Store {
  return { signals: new Map(), exceptions: [], subscriptions: [] };
}

function validSubscription(): SubscriptionRow {
  return {
    subscription_row_key: subscriptionRowKey("acct", false, "sub_current"), environment: "test", livemode: false,
    stripe_account_id: "acct", stripe_subscription_id: "sub_current", stripe_customer_id: "cus_current",
    ghost_member_id: "gm_current", minhos_member_id: "mm_current", stripe_product_id: "product", stripe_price_id: "price",
    ghost_price_id: "", ghost_tier_id: "", tier_name: "", unit_amount_minor: 1000, currency: "jpy",
    billing_interval: "month", stripe_status: "active", ghost_projected_status: "", status_match: "match",
    collection_method: "charge_automatically", pause_collection_behavior: "", cancel_at_period_end: false,
    start_date: "", current_period_start: "", current_period_end: "", canceled_at: "", ended_at: "",
    latest_invoice_id: "", latest_invoice_status: "", open_invoice_count: 0, last_invoice_paid_at: "",
    last_payment_failure_at: "", source_present_stripe: true, source_present_ghost: true, source_missing_since: "",
    last_seen_stripe_run_id: "run_test", last_seen_ghost_run_id: "run_test", last_synced_at: NOW.toISOString(),
  };
}

function refunds(count: number): StripeRefundRaw[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `re_${String(index + 1).padStart(3, "0")}`,
    amount: 100,
    currency: "jpy",
    status: "succeeded",
    created: 1_700_000_000 + index,
    charge: {
      id: `ch_${String(index + 1).padStart(3, "0")}`,
      amount: 1000,
      amount_refunded: 100,
      customer: { id: "cus_current" },
      invoice: {
        id: `in_${String(index + 1).padStart(3, "0")}`,
        status: "paid",
        customer: { id: "cus_current" },
        subscription: { id: "sub_current" },
      },
    },
  }));
}

function disputes(count: number): StripeDisputeRaw[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `dp_${String(index + 1).padStart(3, "0")}`,
    amount: 100,
    currency: "jpy",
    status: "needs_response",
    created: 1_700_000_000 + index,
    charge: {
      id: `ch_dp_${String(index + 1).padStart(3, "0")}`,
      amount: 1000,
      amount_refunded: 0,
      customer: { id: "cus_current" },
      invoice: {
        id: `in_dp_${String(index + 1).padStart(3, "0")}`,
        status: "paid",
        customer: { id: "cus_current" },
        subscription: { id: "sub_current" },
      },
    },
  }));
}

function afterItem<T extends { id: string }>(items: T[], startingAfter?: string): T[] {
  if (!startingAfter) return items;
  const index = items.findIndex((item) => item.id === startingAfter);
  return index < 0 ? [] : items.slice(index + 1);
}

function invoiceSignal(index: number): BillingSignalRow {
  const id = `in_${String(index).padStart(3, "0")}`;
  return {
    signal_key: `stripe:invoice:${id}`, object_type: "invoice", stripe_object_id: id, stripe_event_id: "",
    stripe_subscription_id: "sub_current", stripe_customer_id: "cus_current", invoice_id: id, refund_id: "", dispute_id: "",
    raw_status: "open", signal_kind: "open_invoice", amount_minor: 1000, currency: "jpy",
    occurred_at: NOW.toISOString(), next_payment_attempt_at: "", needs_action: true, resolved_at: "",
    last_seen_run_id: "run_previous", last_synced_at: NOW.toISOString(),
  };
}
