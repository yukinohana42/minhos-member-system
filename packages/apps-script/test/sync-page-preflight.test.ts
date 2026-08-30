import { describe, expect, it, vi } from "vitest";
import type { GhostAdminClient } from "../src/adapters/ghost-admin-client";
import type { RunCoordinator } from "../src/adapters/run-coordination";
import type { SheetsRepository } from "../src/adapters/sheets-repository";
import type { StripeReadOnlyClient } from "../src/adapters/stripe-client";
import type { SyncConfig } from "../src/config";
import type { SyncCursor } from "../src/domain/types";
import { SyncService } from "../src/sync/sync-service";

const FULL_PHASES = [
  "account", "stripe_subscriptions", "ghost_members", "open_invoices", "refunds", "disputes", "tracked_signals", "reconcile",
] as const;
const NOW = new Date("2026-08-28T00:00:00.000Z");

type Endpoint = "subscriptions" | "open_invoices";

const invalidPages = [
  {
    name: "a duplicate item",
    items: [{ id: "object_duplicate" }, { id: "object_duplicate" }],
    hasMore: false,
    expected: "PAGINATION_DUPLICATE_ITEM",
  },
  {
    name: "the request cursor inside the response",
    items: [{ id: "object_cursor" }, { id: "object_next" }],
    hasMore: false,
    requestCursor: "object_cursor",
    expected: "PAGINATION_NO_PROGRESS",
  },
  {
    name: "an empty has_more page",
    items: [],
    hasMore: true,
    expected: "SCHEMA_MISMATCH",
  },
] as const;
const pageCases = (["subscriptions", "open_invoices"] as const)
  .flatMap((endpoint) => invalidPages.map((invalid) => ({ endpoint, ...invalid })));

describe("Stripe list page service preflight", () => {
  it.each(pageCases)(
    "$endpoint rejects $name before mapping or durable writes",
    (invalid) => {
      const { endpoint } = invalid;
      const page = { object: "list" as const, data: [...invalid.items], has_more: invalid.hasMore };
      const stripe = endpoint === "subscriptions"
        ? { listSubscriptions: vi.fn(() => page) }
        : { listOpenInvoices: vi.fn(() => page) };
      const { service, repositoryWrites, cursorWrites, propertyWrites, sendMail } = createService(
        stripe as unknown as StripeReadOnlyClient,
      );
      const cursor = pageCursor(endpoint, "requestCursor" in invalid ? invalid.requestCursor : undefined);
      const before = JSON.stringify(cursor);

      expect(() => processPage(service, endpoint, cursor)).toThrow(
        `${invalid.expected}:stripe_${endpoint}`,
      );
      expect(JSON.stringify(cursor)).toBe(before);
      Object.values(repositoryWrites).forEach((write) => expect(write).not.toHaveBeenCalled());
      Object.values(cursorWrites).forEach((write) => expect(write).not.toHaveBeenCalled());
      Object.values(propertyWrites).forEach((write) => expect(write).not.toHaveBeenCalled());
      expect(sendMail).not.toHaveBeenCalled();
    },
  );
});

function processPage(service: SyncService, endpoint: Endpoint, cursor: SyncCursor): boolean {
  const privateService = service as unknown as {
    processStripeSubscriptionsPage: (cursor: SyncCursor, phases: readonly string[], deadlineMs: number) => boolean;
    processOpenInvoicesPage: (cursor: SyncCursor, phases: readonly string[], deadlineMs: number) => boolean;
  };
  return endpoint === "subscriptions"
    ? privateService.processStripeSubscriptionsPage(cursor, FULL_PHASES, NOW.getTime() + 300_000)
    : privateService.processOpenInvoicesPage(cursor, FULL_PHASES, NOW.getTime() + 300_000);
}

function createService(stripe: StripeReadOnlyClient): {
  service: SyncService;
  repositoryWrites: Record<string, ReturnType<typeof vi.fn>>;
  cursorWrites: Record<string, ReturnType<typeof vi.fn>>;
  propertyWrites: Record<string, ReturnType<typeof vi.fn>>;
  sendMail: ReturnType<typeof vi.fn>;
} {
  const repositoryWrites = {
    upsert: vi.fn(),
    replace: vi.fn(),
    appendSyncLog: vi.fn(),
    writeDashboard: vi.fn(),
    upsertOwnedRowsInPlace: vi.fn(),
  };
  const repository = {
    read: vi.fn(() => []),
    ...repositoryWrites,
  } as unknown as SheetsRepository;
  const cursorWrites = {
    writeCursor: vi.fn(),
    scheduleResume: vi.fn(),
    clearCursor: vi.fn(),
  };
  const propertyWrites = {
    setProperty: vi.fn(),
    deleteProperty: vi.fn(),
  };
  const properties = {
    getProperty: vi.fn(() => null),
    getProperties: vi.fn(() => ({})),
    ...propertyWrites,
  } as unknown as GoogleAppsScript.Properties.Properties;
  const sendMail = vi.fn();
  const service = new SyncService({
    config: config(),
    properties,
    repository,
    coordinator: { renew: vi.fn(), ...cursorWrites } as unknown as RunCoordinator,
    ghost: {} as GhostAdminClient,
    stripe,
    now: () => new Date(NOW),
    uuid: () => "uuid",
    sendMail,
    setRetryDeadline: vi.fn(),
  });
  return { service, repositoryWrites, cursorWrites, propertyWrites, sendMail };
}

function pageCursor(endpoint: Endpoint, requestCursor?: string): SyncCursor {
  return {
    schemaVersion: 1,
    contextFingerprint: "test",
    runId: "run_test",
    requestedRunType: "nightly",
    phase: endpoint === "subscriptions" ? "stripe_subscriptions" : "open_invoices",
    startedAt: NOW.toISOString(),
    ...(requestCursor ? { stripeStartingAfter: requestCursor } : {}),
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
