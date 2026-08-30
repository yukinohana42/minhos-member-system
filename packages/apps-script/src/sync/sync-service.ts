import { StripeReadOnlyClient } from "../adapters/stripe-client";
import { GhostAdminClient } from "../adapters/ghost-admin-client";
import {
  RunCoordinator,
  RunLeaseFenced,
  type InvalidSyncCursorInspection,
} from "../adapters/run-coordination";
import { withScriptLock } from "../adapters/script-lock";
import { SheetsRepository } from "../adapters/sheets-repository";
import type { SyncConfig } from "../config";
import { assertBillingSignalsInScope, billingScopeExceptionFinding, billingSignalScopeViolation } from "../domain/billing-scope";
import {
  planUnseenOpenInvoicePage,
  reconcileRetrievedInvoice,
} from "../domain/billing-signal-lifecycle";
import { mapDisputeSignal, mapInvoiceSignal, mapRefundSignal, type BillingLookups } from "../domain/billing-signals";
import { findOperationalExceptions, reconcileExceptionRows } from "../domain/exceptions";
import { mapGhostMember } from "../domain/ghost-mapper";
import { nextGhostPage } from "../domain/ghost-pagination";
import { HttpFailure } from "../domain/http";
import { HttpBudgetExceeded } from "../domain/http";
import {
  assertAccessGrantIdentityIntegrity,
  assertMemberIdentityIntegrity,
  assertSubscriptionIdentityIntegrity,
} from "../domain/identity-integrity";
import { exceptionKey, memberRowKey } from "../domain/keys";
import { LookupCache } from "../domain/lookup-cache";
import { markAndSweep } from "../domain/mark-sweep";
import {
  completeNotificationOutboxItems,
  enqueueNotificationOutbox,
  markNotificationOutboxSent,
  notificationDecisionsForItems,
  planNotificationOutboxDelivery,
  repairNotificationOutboxProperties,
  serializeNotificationOutboxItem,
  type NotificationOutboxItem,
} from "../domain/notification-outbox";
import { markNotificationsSent, notificationDeliveryBatch, planExceptionNotifications } from "../domain/notifications";
import { deriveProfileStatus } from "../domain/profile";
import { assertSafePropertyStoreWrites } from "../domain/property-quota";
import { deriveThreeAxisState } from "../domain/state";
import { planTrackedSignalPage } from "../domain/tracked-signals";
import { isRuntimeBudgetExhausted, shouldRenewLease, SyncYieldRequested } from "../domain/runtime-budget";
import { nextStripePageCursor, validateStripePage } from "../domain/stripe-pagination";
import {
  mapStripeSubscription,
  mergeGhostProjection,
  mergeStripeRefreshSourcePresence,
  validateStripeAccount,
  type StripeScope,
} from "../domain/stripe-mapper";
import { environmentMarker, syncContextFingerprint } from "../domain/sync-context";
import type {
  AccessGrantRow,
  BillingSignalRow,
  ExceptionFinding,
  ExceptionRow,
  GhostSubscriptionProjection,
  MemberRow,
  RunType,
  SheetRecord,
  StripeChargeRaw,
  StripeDisputeRaw,
  StripePaymentIntentRaw,
  StripeRefundRaw,
  SubscriptionRow,
  SyncCursor,
} from "../domain/types";
import { idOf, redactSecrets } from "../domain/values";

const MEMBER_GHOST_COLUMNS = [
  "member_row_key", "minhos_member_id", "ghost_site_id", "ghost_member_id", "member_uuid", "email", "name",
  "ghost_member_status", "ghost_access_state", "tier_ids", "stripe_customer_ids", "stripe_customer_count", "profile_status", "created_at",
  "updated_at", "last_synced_at", "source_present_ghost", "source_missing_since", "last_seen_ghost_run_id",
  "source_record_hash",
];

const SUBSCRIPTION_STRIPE_COLUMNS = [
  "subscription_row_key", "environment", "livemode", "stripe_account_id", "stripe_subscription_id",
  "stripe_customer_id", "stripe_product_id", "stripe_price_id", "unit_amount_minor", "currency", "billing_interval",
  "stripe_status", "collection_method", "pause_collection_behavior", "cancel_at_period_end", "start_date",
  "current_period_start", "current_period_end", "canceled_at", "ended_at", "latest_invoice_id",
  "latest_invoice_status", "last_invoice_paid_at", "last_payment_failure_at", "source_present_stripe",
  "source_missing_since", "last_seen_stripe_run_id", "last_synced_at",
];

const SUBSCRIPTION_GHOST_COLUMNS = [
  "ghost_member_id", "minhos_member_id", "ghost_price_id", "ghost_tier_id", "tier_name",
  "ghost_projected_status", "status_match", "source_present_ghost", "source_missing_since",
  "last_seen_ghost_run_id", "last_synced_at",
];

const GRANT_GHOST_COLUMNS = [
  "grant_key", "minhos_member_id", "ghost_member_id", "tier_id", "grant_kind", "starts_at", "expires_at",
  "source_present_ghost", "source_missing_since", "last_seen_ghost_run_id", "last_synced_at",
];

const FULL_PHASES = [
  "account", "stripe_subscriptions", "ghost_members", "open_invoices", "refunds", "disputes", "tracked_signals", "reconcile",
] as const;
const HOURLY_PHASES = ["account", "stripe_subscriptions", "ghost_members", "reconcile"] as const;
const TRACKED_SIGNAL_PAGE_SIZE = 10;
/** Keep N+1 work bounded even when the list endpoint returns 100 objects. */
const BILLING_ITEM_CHUNK_SIZE = 10;
/** Keep full-scan invoice re-fetches bounded and item-committed. */
const RECONCILE_INVOICE_CHUNK_SIZE = 10;

type ReconcileTombstoneTable = NonNullable<SyncCursor["reconcileTombstoneCommit"]>["table"];

const RECONCILE_TOMBSTONE_TABLE_ORDER: Readonly<Record<ReconcileTombstoneTable, number>> = {
  members: 0,
  subscriptions: 1,
  grants: 2,
};

/**
 * A reconcile mutation may have committed even though its cursor checkpoint
 * failed. The durable pre-mutation marker must be preserved for an
 * idempotent resume instead of entering generic failure cleanup.
 */
class ReconcileCommitRetryRequested extends Error {
  constructor() {
    super("RECONCILE_COMMIT_RETRY_REQUESTED");
  }
}

interface SyncDependencies {
  config: SyncConfig;
  properties: GoogleAppsScript.Properties.Properties;
  repository: SheetsRepository;
  coordinator: RunCoordinator;
  ghost: GhostAdminClient;
  stripe: StripeReadOnlyClient;
  now: () => Date;
  uuid: () => string;
  sendMail: (to: string, subject: string, body: string) => void;
  setRetryDeadline: (deadlineMs: number | null) => void;
}

export class SyncService {
  private readonly chargeCache = new LookupCache<StripeChargeRaw>();
  private readonly paymentIntentCache = new LookupCache<StripePaymentIntentRaw>();
  private readonly invoiceCache = new LookupCache<ReturnType<StripeReadOnlyClient["retrieveInvoice"]>>();
  private lastLeaseRenewedAtMs = 0;
  private leaseOwnerId = "";

  constructor(private readonly deps: SyncDependencies) {}

  run(requestedRunType: Exclude<RunType, "resume"> | "resume"): void {
    const fingerprint = syncContextFingerprint(this.deps.config);
    const cursorInspection = this.deps.coordinator.inspectCursor({
      contextFingerprint: fingerprint,
      schemaVersion: this.deps.config.schemaVersion,
    });
    const existingCursor = cursorInspection.status === "valid" ? cursorInspection.cursor : null;
    const invalidCursorInspection: InvalidSyncCursorInspection | null = cursorInspection.status === "invalid"
      ? cursorInspection
      : null;
    if (requestedRunType === "resume" && cursorInspection.status === "absent") return;
    const cursor = existingCursor ?? this.newCursor(requestedRunType === "resume" ? "manual" : requestedRunType);
    this.deps.repository.preflightEnvironmentMarker(environmentMarker(this.deps.config));
    // Keep marker/identity failures fully observation-only, including when a
    // malformed lease is present. Identity is checked again after the atomic
    // cursor-snapshot claim so the trusted view is also lease-fenced.
    this.deps.repository.preflightIdentityIntegrity();
    this.leaseOwnerId = `lease_${this.deps.uuid()}`;
    this.lastLeaseRenewedAtMs = 0;
    const deadlineMs = this.deps.now().getTime() + this.deps.config.maxRuntimeMs;
    this.deps.coordinator.claim(cursor.runId, this.deps.now().getTime(), this.leaseOwnerId, cursorInspection);
    let identityPreflightComplete = false;
    let cursorQuarantineCommitted = false;
    try {
      // Fence the claimed run before trusting any persisted identity. Until
      // this full repository preflight succeeds, failures must remain
      // observation-only: no cursor quarantine, exception, outbox, mail,
      // SyncLog, or retry-state mutation is safe against corrupt identities.
      this.checkpoint(cursor, deadlineMs, true);
      this.deps.repository.preflightIdentityIntegrity();
      // Identity traversal can outlive a short lease. Fence immediately after
      // it and again inside every cursor mutation below.
      this.deps.coordinator.assertOwner(cursor.runId, this.leaseOwnerId);
      identityPreflightComplete = true;
      if (invalidCursorInspection) {
        // The invalid source remains untouched until the environment marker,
        // lease fence, and complete identity preflight have all succeeded.
        // Compare-and-delete prevents a stale inspection from removing a
        // cursor that changed while this invocation was waiting to claim.
        this.deps.coordinator.commitCursorQuarantine(
          invalidCursorInspection,
          cursor.runId,
          this.leaseOwnerId,
          this.deps.now(),
        );
        cursorQuarantineCommitted = true;
        this.recordCursorQuarantine(cursor, invalidCursorInspection.reason);
      }
      // A resume trigger with a quarantined cursor has no safe phase to
      // continue. It records the quarantine and stops; the next scheduled or
      // manual run starts with a fresh cursor.
      if (requestedRunType === "resume" && invalidCursorInspection) return;
      cursor.attempts = [...(cursor.attempts ?? []), {
        startedAt: this.deps.now().toISOString(),
        entrypoint: requestedRunType,
      }].slice(-50);
      this.deps.setRetryDeadline(deadlineMs);
      if (requestedRunType === "resume") {
        this.verifyStripeBoundary(cursor, deadlineMs);
        // Re-fence after the external boundary calls before committing the
        // resumed cursor or delivering pending notifications.
        this.checkpoint(cursor, deadlineMs, true);
      }
      this.deps.coordinator.writeCursor(cursor, this.leaseOwnerId);
      this.flushPendingNotifications(this.deps.now().toISOString());
      this.process(cursor, deadlineMs);
    } catch (error) {
      // Another execution has taken over this cursor/run after lease expiry.
      // The stale execution must not write a failure, cursor, or Sheet row.
      if (error instanceof RunLeaseFenced) return;
      // Persisted identities are not trustworthy enough to key even a
      // failure/quarantine row. Preserve the preflight's original error and
      // release the lease in finally without mutating any durable run state.
      if (!identityPreflightComplete) throw error;
      // A quarantine property write/delete failure must leave the inspected
      // cursor available for a later safe retry. Do not route it through the
      // generic failure branch, whose non-retryable cleanup clears cursors.
      if (invalidCursorInspection && !cursorQuarantineCommitted) throw error;
      try {
        this.deps.coordinator.renew(cursor.runId, this.deps.now().getTime(), this.leaseOwnerId);
      } catch (coordinationError) {
        if (coordinationError instanceof RunLeaseFenced ||
          (coordinationError instanceof Error && coordinationError.message === "SYNC_LOCK_BUSY")) return;
        throw coordinationError;
      }
      if (error instanceof SyncYieldRequested || error instanceof HttpBudgetExceeded) {
        this.pause(cursor);
        return;
      }
      if (error instanceof ReconcileCommitRetryRequested) {
        // The cursor still contains the last successfully persisted pending
        // or committed marker. Do not log a zero tombstone count and do not
        // clear it; the next owner replays the uncertain replace exactly once.
        this.deps.coordinator.assertOwner(cursor.runId, this.leaseOwnerId);
        this.deps.coordinator.scheduleResume();
        return;
      }
      this.recordFailure(cursor, error);
      if (isRetryable(error)) {
        this.deps.coordinator.writeCursor(cursor, this.leaseOwnerId);
        this.deps.coordinator.scheduleResume();
      } else {
        this.deps.coordinator.clearCursor(cursor.runId, this.leaseOwnerId);
      }
      throw error;
    } finally {
      this.deps.setRetryDeadline(null);
      this.deps.coordinator.release(cursor.runId, this.leaseOwnerId);
    }
  }

  private process(cursor: SyncCursor, deadlineMs: number): void {
    const phases = this.phases(cursor.requestedRunType);
    while (true) {
      this.checkpoint(cursor, deadlineMs);
      switch (cursor.phase) {
        case "account":
          this.verifyStripeBoundary(cursor, deadlineMs);
          this.advance(cursor, phases);
          break;
        case "stripe_subscriptions":
          if (this.processStripeSubscriptionsPage(cursor, phases, deadlineMs)) return;
          break;
        case "ghost_members":
          if (this.processGhostMembersPage(cursor, phases, deadlineMs)) return;
          break;
        case "open_invoices":
          if (this.processOpenInvoicesPage(cursor, phases, deadlineMs)) return;
          break;
        case "refunds":
          if (this.processRefundsPage(cursor, phases, deadlineMs)) return;
          break;
        case "disputes":
          if (this.processDisputesPage(cursor, phases, deadlineMs)) return;
          break;
        case "tracked_signals":
          if (this.refreshTrackedSignalsPage(cursor, phases, deadlineMs)) return;
          break;
        case "reconcile":
          if (this.reconcile(cursor, deadlineMs)) return;
          return;
        default:
          throw new Error(`INVALID_SYNC_PHASE:${cursor.phase}`);
      }
      this.checkpoint(cursor, deadlineMs);
      this.deps.coordinator.writeCursor(cursor, this.leaseOwnerId);
      if (this.shouldYield(deadlineMs)) {
        this.pause(cursor);
        return;
      }
    }
  }

  private verifyStripeBoundary(cursor: SyncCursor, deadlineMs: number): void {
    this.checkpoint(cursor, deadlineMs);
    validateStripeAccount(this.deps.stripe.getAccount().id, this.deps.config.stripeAccountId);
    for (const id of this.deps.config.stripeProductIds) {
      this.checkpoint(cursor, deadlineMs);
      const product = this.deps.stripe.retrieveProduct(id);
      if (product.id !== id) throw new Error(`STRIPE_PRODUCT_MISMATCH:${id}`);
    }
    for (const id of this.deps.config.stripePriceIds) {
      this.checkpoint(cursor, deadlineMs);
      const price = this.deps.stripe.retrievePrice(id);
      if (price.id !== id) throw new Error(`STRIPE_PRICE_MISMATCH:${id}`);
      const product = price.product;
      const expandedProductId = product && typeof product === "object"
        ? (product as { id?: unknown }).id
        : undefined;
      const productId = typeof product === "string"
        ? product
        : typeof expandedProductId === "string"
          ? expandedProductId
          : "";
      if (!this.deps.config.stripeProductIds.has(productId)) {
        throw new Error(`STRIPE_PRICE_PRODUCT_SCOPE_VIOLATION:${id}`);
      }
    }
  }

  private processStripeSubscriptionsPage(
    cursor: SyncCursor,
    phases: readonly string[],
    deadlineMs: number,
  ): boolean {
    const persistedSubscriptions = this.deps.repository.read<SubscriptionRow>("20_Subscriptions");
    assertSubscriptionIdentityIntegrity(
      persistedSubscriptions,
      { stripeAccountId: this.deps.config.stripeAccountId, livemode: this.deps.config.livemode },
    );
    const persistedByKey = new Map(
      persistedSubscriptions.map((row) => [row.subscription_row_key, row]),
    );
    const requestCursor = cursor.stripeStartingAfter;
    const page = this.deps.stripe.listSubscriptions(requestCursor);
    validateStripePage({
      endpoint: "subscriptions", items: page.data, hasMore: page.has_more,
      ...(requestCursor ? { requestCursor } : {}),
    });
    const nextCursor = nextStripePageCursor({
      endpoint: "subscriptions",
      hasMore: page.has_more,
      ...(requestCursor ? { currentCursor: requestCursor } : {}),
      ...(page.data.length ? { lastId: page.data[page.data.length - 1]!.id } : {}),
    });
    const rows: SubscriptionRow[] = [];
    const invoiceSignals: BillingSignalRow[] = [];
    const scope = this.stripeScope();
    const nowIso = this.deps.now().toISOString();
    for (const raw of page.data) {
      this.checkpoint(cursor, deadlineMs);
      const mapping = mapStripeSubscription(raw, scope, { runId: cursor.runId, nowIso });
      if (!mapping.accepted) {
        throw new Error(`STRIPE_SCOPE_VIOLATION:subscription:${mapping.reason}`);
      }
      const row = mergeStripeRefreshSourcePresence(
        mapping.row,
        persistedByKey.get(mapping.row.subscription_row_key),
      );
      rows.push(row);
      if (typeof raw.latest_invoice === "object" && raw.latest_invoice) {
        const signal = mapInvoiceSignal(raw.latest_invoice, { runId: cursor.runId, nowIso });
        this.assertSignalsInScope([signal], cursor, [row]);
        invoiceSignals.push(signal);
      }
    }
    this.checkpoint(cursor, deadlineMs, true);
    this.addUpsertCounts(cursor, this.deps.repository.upsert("20_Subscriptions", rows, SUBSCRIPTION_STRIPE_COLUMNS));
    this.checkpoint(cursor, deadlineMs, true);
    this.addUpsertCounts(cursor, this.deps.repository.upsert("25_BillingSignals", invoiceSignals));
    this.addStats(cursor, "stripe", page.data.length);
    if (nextCursor) {
      cursor.stripeStartingAfter = nextCursor;
      this.deps.coordinator.writeCursor(cursor, this.leaseOwnerId);
      if (this.shouldYield(deadlineMs)) {
        this.pause(cursor);
        return true;
      }
    } else {
      delete cursor.stripeStartingAfter;
      this.advance(cursor, phases);
    }
    return false;
  }

  private processGhostMembersPage(cursor: SyncCursor, phases: readonly string[], deadlineMs: number): boolean {
    const pageNumber = cursor.ghostPage ?? 1;
    const page = this.deps.ghost.getMembersPage(pageNumber);
    // This assertion must happen before any page rows are persisted.
    const next = nextGhostPage(page, pageNumber);
    const persistedMembers = this.deps.repository.read<MemberRow>("10_Members");
    assertMemberIdentityIntegrity(persistedMembers, this.deps.config.ghostSiteId);
    assertAccessGrantIdentityIntegrity(
      this.deps.repository.read<AccessGrantRow>("21_AccessGrants"),
      this.deps.config.ghostSiteId,
    );
    const existingMembers = new Map(persistedMembers.map((row) => [row.member_row_key, row]));
    const supplementalRows = this.deps.repository.read<SheetRecord>("40_Supplemental");
    const members: MemberRow[] = [];
    const grants: AccessGrantRow[] = [];
    const projections: GhostSubscriptionProjection[] = [];
    const nowIso = this.deps.now().toISOString();
    for (const raw of page.members) {
      this.checkpoint(cursor, deadlineMs);
      const key = memberRowKey(this.deps.config.ghostSiteId, raw.id);
      const existing = existingMembers.get(key);
      const minhosMemberId = existing?.minhos_member_id || `mm_${this.deps.uuid()}`;
      const mapping = mapGhostMember(raw, {
        ghostSiteId: this.deps.config.ghostSiteId,
        minhosMemberId,
        profileStatus: deriveProfileStatus(minhosMemberId, supplementalRows),
        runId: cursor.runId,
        nowIso,
      });
      members.push(mapping.member);
      grants.push(...mapping.grants);
      projections.push(...mapping.subscriptions);
    }
    this.checkpoint(cursor, deadlineMs, true);
    this.addUpsertCounts(cursor, this.deps.repository.upsert("10_Members", members, MEMBER_GHOST_COLUMNS));
    this.checkpoint(cursor, deadlineMs, true);
    this.addUpsertCounts(cursor, this.deps.repository.upsert("21_AccessGrants", grants, GRANT_GHOST_COLUMNS));
    this.applyGhostProjections(projections, nowIso, cursor, deadlineMs);
    this.addStats(cursor, "ghost", page.members.length);

    if (next) {
      cursor.ghostPage = next;
      this.deps.coordinator.writeCursor(cursor, this.leaseOwnerId);
      if (this.shouldYield(deadlineMs)) {
        this.pause(cursor);
        return true;
      }
    } else {
      delete cursor.ghostPage;
      this.advance(cursor, phases);
    }
    return false;
  }

  private processOpenInvoicesPage(cursor: SyncCursor, phases: readonly string[], deadlineMs: number): boolean {
    const requestCursor = cursor.stripeStartingAfter;
    const page = this.deps.stripe.listOpenInvoices(requestCursor);
    validateStripePage({
      endpoint: "open_invoices", items: page.data, hasMore: page.has_more,
      ...(requestCursor ? { requestCursor } : {}),
    });
    const nextCursor = nextStripePageCursor({
      endpoint: "open_invoices",
      hasMore: page.has_more,
      ...(requestCursor ? { currentCursor: requestCursor } : {}),
      ...(page.data.length ? { lastId: page.data[page.data.length - 1]!.id } : {}),
    });
    const nowIso = this.deps.now().toISOString();
    const signals = page.data.map((invoice) => mapInvoiceSignal(invoice, { runId: cursor.runId, nowIso }));
    this.checkpoint(cursor, deadlineMs);
    const ledgerSignals = this.selectLedgerSignals(signals, cursor, deadlineMs);
    this.checkpoint(cursor, deadlineMs, true);
    this.addUpsertCounts(cursor, this.deps.repository.upsert("25_BillingSignals", ledgerSignals));
    this.addStats(cursor, "billing", page.data.length);
    return this.finishStripePage(cursor, phases, deadlineMs, nextCursor);
  }

  private processRefundsPage(cursor: SyncCursor, phases: readonly string[], deadlineMs: number): boolean {
    const requestCursor = cursor.stripeStartingAfter;
    const watermark = this.pinnedBillingLowerBound(cursor, "REFUND", deadlineMs);
    const page = this.deps.stripe.listRefunds(watermark, requestCursor);
    // Validate the complete response before touching the ledger. The cursor
    // is the last committed item, so each resume request may return a fresh
    // page segment rather than an in-memory page snapshot.
    validateStripePage({
      endpoint: "refunds", items: page.data, hasMore: page.has_more,
      ...(requestCursor ? { requestCursor } : {}),
    });
    const nowIso = this.deps.now().toISOString();
    const refundTotalsByCharge = successfulRefundTotalsByCharge(page.data);
    const endIndex = Math.min(page.data.length, BILLING_ITEM_CHUNK_SIZE);
    for (let index = 0; index < endIndex; index += 1) {
      const refund = page.data[index]!;
      this.checkpoint(cursor, deadlineMs);
      const signal = mapRefundSignal(
        refund,
        this.lookupsFor(refund, cursor, deadlineMs, refundTotalsByCharge),
        { runId: cursor.runId, nowIso },
      );
      const ledgerSignals = this.selectLedgerSignals([signal], cursor, deadlineMs);
      // Renew/fence immediately before the item mutation. If this invocation
      // yields before the write, the cursor remains on the prior item and the
      // same item is safely retried on the next invocation.
      this.checkpoint(cursor, deadlineMs, true);
      this.addUpsertCounts(cursor, this.deps.repository.upsert("25_BillingSignals", ledgerSignals));
      this.addBillingRecordStats(cursor, 1);
      // Advance only after the ledger mutation succeeds. Upsert is idempotent
      // by signal_key, so a cursor-write failure cannot lose or duplicate an
      // item on retry. `stripeStartingAfter` doubles as the item cursor.
      cursor.stripeStartingAfter = refund.id;
      this.deps.coordinator.writeCursor(cursor, this.leaseOwnerId);
      if (this.shouldYield(deadlineMs)) {
        this.pause(cursor);
        return true;
      }
    }
    this.addBillingPageStats(cursor);
    if (endIndex < page.data.length || page.has_more) {
      this.pause(cursor);
      return true;
    }
    // Persist the terminal marker before advancing to the next phase. A
    // later checkpoint or phase transition failure must not leave a cursor in
    // `disputes` while the Refund watermark still points at the old run.
    this.checkpoint(cursor, deadlineMs, true);
    this.setStateProperty(this.stateKey("REFUND_WATERMARK_UNIX"), String(Math.floor(this.deps.now().getTime() / 1000)));
    this.advance(cursor, phases);
    return false;
  }

  private processDisputesPage(cursor: SyncCursor, phases: readonly string[], deadlineMs: number): boolean {
    // The first completed deployment scan intentionally has no created[gte]
    // filter: an old but still-open dispute must not disappear behind the
    // rolling watermark. Stripe pagination plus stripeStartingAfter is the
    // durable checkpoint until the entire history has completed once.
    const historyComplete = this.deps.properties.getProperty(this.stateKey("DISPUTE_HISTORY_COMPLETE")) === "true";
    const requestCursor = cursor.stripeStartingAfter;
    // A cursor value is authoritative for an in-flight phase. In particular,
    // `null` must remain an unbounded history scan even if the terminal
    // history marker was written just before a crash interrupted advance().
    const watermark = cursor.stripeCreatedGte !== undefined
      ? cursor.stripeCreatedGte === null
        ? undefined
        : cursor.stripeCreatedGte
      : historyComplete
        ? this.pinnedBillingLowerBound(cursor, "DISPUTE", deadlineMs)
        : this.pinInitialDisputeHistory(cursor, deadlineMs);
    const page = this.deps.stripe.listDisputes(watermark, requestCursor);
    validateStripePage({
      endpoint: "disputes", items: page.data, hasMore: page.has_more,
      ...(requestCursor ? { requestCursor } : {}),
    });
    const nowIso = this.deps.now().toISOString();
    const endIndex = Math.min(page.data.length, BILLING_ITEM_CHUNK_SIZE);
    for (let index = 0; index < endIndex; index += 1) {
      const dispute = page.data[index]!;
      this.checkpoint(cursor, deadlineMs);
      const signal = mapDisputeSignal(dispute, this.lookupsFor(dispute, cursor, deadlineMs), { runId: cursor.runId, nowIso });
      const ledgerSignals = this.selectLedgerSignals([signal], cursor, deadlineMs);
      this.checkpoint(cursor, deadlineMs, true);
      this.addUpsertCounts(cursor, this.deps.repository.upsert("25_BillingSignals", ledgerSignals));
      this.addBillingRecordStats(cursor, 1);
      cursor.stripeStartingAfter = dispute.id;
      this.deps.coordinator.writeCursor(cursor, this.leaseOwnerId);
      if (this.shouldYield(deadlineMs)) {
        this.pause(cursor);
        return true;
      }
    }
    this.addBillingPageStats(cursor);
    if (endIndex < page.data.length || page.has_more) {
      this.pause(cursor);
      return true;
    }
    this.checkpoint(cursor, deadlineMs, true);
    this.setStateProperty(this.stateKey("DISPUTE_WATERMARK_UNIX"), String(Math.floor(this.deps.now().getTime() / 1000)));
    this.setStateProperty(this.stateKey("DISPUTE_HISTORY_COMPLETE"), "true");
    this.advance(cursor, phases);
    return false;
  }

  private refreshTrackedSignalsPage(cursor: SyncCursor, phases: readonly string[], deadlineMs: number): boolean {
    const page = planTrackedSignalPage({
      signals: this.deps.repository.read<BillingSignalRow>("25_BillingSignals"),
      exceptions: this.deps.repository.read<ExceptionRow>("50_Exceptions"),
      ...(cursor.trackedSignalAfterKey ? { afterKey: cursor.trackedSignalAfterKey } : {}),
      limit: TRACKED_SIGNAL_PAGE_SIZE,
    });
    const nowIso = this.deps.now().toISOString();
    for (const row of page.rows) {
      this.checkpoint(cursor, deadlineMs);
      let mapped: BillingSignalRow;
      if (row.object_type === "refund") {
        const raw = this.deps.stripe.retrieveRefund(row.refund_id);
        mapped = mapRefundSignal(raw, this.lookupsFor(raw, cursor, deadlineMs), { runId: cursor.runId, nowIso });
      } else {
        const raw = this.deps.stripe.retrieveDispute(row.dispute_id);
        mapped = mapDisputeSignal(raw, this.lookupsFor(raw, cursor, deadlineMs), { runId: cursor.runId, nowIso });
      }
      const ledgerRows = this.selectLedgerSignals([mapped], cursor, deadlineMs);
      this.checkpoint(cursor, deadlineMs, true);
      this.addUpsertCounts(cursor, this.deps.repository.upsert("25_BillingSignals", ledgerRows));
      this.addStats(cursor, "billing", 1);
      // Commit the item cursor only after its ledger mutation succeeds. A
      // yielded invocation therefore resumes from N+1, not from N.
      cursor.trackedSignalAfterKey = row.signal_key;
      this.deps.coordinator.writeCursor(cursor, this.leaseOwnerId);
    }
    if (!page.hasMore) {
      delete cursor.trackedSignalAfterKey;
      this.advance(cursor, phases);
      return false;
    }
    if (this.shouldYield(deadlineMs)) {
      this.pause(cursor);
      return true;
    }
    return false;
  }

  private lookupsFor(
    signal: StripeRefundRaw | StripeDisputeRaw,
    cursor: SyncCursor,
    deadlineMs: number,
    refundTotalsByCharge?: ReadonlyMap<string, number>,
  ): BillingLookups {
    const charges = new Map<string, StripeChargeRaw>();
    const paymentIntents = new Map<string, StripePaymentIntentRaw>();
    const invoices = new Map<string, ReturnType<StripeReadOnlyClient["retrieveInvoice"]>>();
    const chargeId = idOf(signal.charge);
    const charge = typeof signal.charge === "object" && signal.charge
      ? this.chargeCache.remember(signal.charge.id, signal.charge)
      : chargeId
        ? this.chargeCache.getOrLoad(chargeId, (id) => {
            this.checkpoint(cursor, deadlineMs);
            return this.deps.stripe.retrieveCharge(id);
          })
        : undefined;
    if (charge) charges.set(charge.id, charge);
    const paymentIntentId = idOf(signal.payment_intent) || idOf(charge?.payment_intent);
    const paymentIntent =
      (typeof signal.payment_intent === "object" && signal.payment_intent
        ? this.paymentIntentCache.remember(signal.payment_intent.id, signal.payment_intent)
        : undefined) ??
      (charge?.payment_intent && typeof charge.payment_intent === "object"
        ? this.paymentIntentCache.remember(charge.payment_intent.id, charge.payment_intent)
        : undefined) ??
      (paymentIntentId
        ? this.paymentIntentCache.getOrLoad(paymentIntentId, (id) => {
            this.checkpoint(cursor, deadlineMs);
            return this.deps.stripe.retrievePaymentIntent(id);
          })
        : undefined);
    if (paymentIntent) paymentIntents.set(paymentIntent.id, paymentIntent);
    const invoiceId = idOf(charge?.invoice) || idOf(paymentIntent?.invoice);
    const expandedInvoice =
      (charge && typeof charge.invoice === "object" ? charge.invoice : undefined) ??
      (paymentIntent && typeof paymentIntent.invoice === "object" ? paymentIntent.invoice : undefined);
    const invoice = expandedInvoice
      ? this.invoiceCache.remember(expandedInvoice.id, expandedInvoice)
      : invoiceId
        ? this.invoiceCache.getOrLoad(invoiceId, (id) => {
            this.checkpoint(cursor, deadlineMs);
            return this.deps.stripe.retrieveInvoice(id);
          })
        : undefined;
    if (invoice) invoices.set(invoice.id, invoice);
    return {
      charges,
      paymentIntents,
      invoices,
      ...(refundTotalsByCharge ? { refundTotalsByCharge } : {}),
    };
  }

  private reconcile(cursor: SyncCursor, deadlineMs: number): boolean {
    const now = this.deps.now();
    const nowIso = now.toISOString();
    const fullScan = cursor.requestedRunType === "nightly" || cursor.requestedRunType === "manual";
    let members = this.deps.repository.read<MemberRow>("10_Members");
    let subscriptions = this.deps.repository.read<SubscriptionRow>("20_Subscriptions");
    let grants = this.deps.repository.read<AccessGrantRow>("21_AccessGrants");
    let signals = this.deps.repository.read<BillingSignalRow>("25_BillingSignals");
    assertMemberIdentityIntegrity(members, this.deps.config.ghostSiteId);
    assertSubscriptionIdentityIntegrity(subscriptions, {
      stripeAccountId: this.deps.config.stripeAccountId,
      livemode: this.deps.config.livemode,
    });
    assertAccessGrantIdentityIntegrity(grants, this.deps.config.ghostSiteId);

    // A full scan can discover old actionable invoices that are absent from
    // the current open-invoice list. Retrieve and commit those one at a time
    // before the aggregate reconciliation below. The persisted item cursor
    // makes a runtime yield restart at the next signal rather than repeating
    // the entire N+1 set with no durable progress.
    if (this.refreshUnseenOpenInvoiceItems(cursor, deadlineMs, fullScan)) return true;
    signals = this.deps.repository.read<BillingSignalRow>("25_BillingSignals");

    const memberSweep = markAndSweep({
      records: members,
      keyColumn: "member_row_key",
      lastSeenColumn: "last_seen_ghost_run_id",
      sourcePresentColumn: "source_present_ghost",
      sourceMissingSinceColumn: "source_missing_since",
      completedFullScan: fullScan,
      runId: cursor.runId,
      nowIso,
    });
    members = memberSweep.records;
    const grantSweep = markAndSweep({
      records: grants,
      keyColumn: "grant_key",
      lastSeenColumn: "last_seen_ghost_run_id",
      sourcePresentColumn: "source_present_ghost",
      sourceMissingSinceColumn: "source_missing_since",
      completedFullScan: fullScan,
      runId: cursor.runId,
      nowIso,
    });
    grants = grantSweep.records;
    const stripeSweep = markAndSweep({
      records: subscriptions,
      keyColumn: "subscription_row_key",
      lastSeenColumn: "last_seen_stripe_run_id",
      sourcePresentColumn: "source_present_stripe",
      sourceMissingSinceColumn: "source_missing_since",
      completedFullScan: fullScan,
      runId: cursor.runId,
      nowIso,
    });
    const ghostProjectionSweep = markAndSweep({
      records: stripeSweep.records,
      keyColumn: "subscription_row_key",
      lastSeenColumn: "last_seen_ghost_run_id",
      sourcePresentColumn: "source_present_ghost",
      sourceMissingSinceColumn: "source_missing_since",
      completedFullScan: fullScan,
      runId: cursor.runId,
      nowIso,
    });
    // A Ghost projection tombstone retains its last-seen run and Member pair.
    // A never-projected Stripe-only row was already source_present_ghost=false
    // with both IDs blank, so the sweep leaves that distinct state untouched.
    subscriptions = ghostProjectionSweep.records.map((row) => {
      const historicalGhostProjectionMissing =
        fullScan &&
        row.source_present_ghost === false &&
        row.last_seen_ghost_run_id !== "" &&
        row.last_seen_ghost_run_id !== cursor.runId;
      return historicalGhostProjectionMissing
        ? { ...row, ghost_projected_status: "", status_match: "missing_ghost_projection" }
        : row;
    });

    if (fullScan) {
      this.checkpoint(cursor, deadlineMs, true);
      this.deps.repository.replace("25_BillingSignals", signals);
    }

    const openInvoiceCounts = countOpenInvoices(signals);
    subscriptions = subscriptions.map((subscription) => ({
      ...subscription,
      open_invoice_count: openInvoiceCounts.get(subscription.stripe_subscription_id) ?? 0,
    }));

    members = members.map((member) => {
      const state = deriveThreeAxisState({
        ghostAccess: member.ghost_access_state,
        subscriptions: subscriptions.filter((row) => row.ghost_member_id === member.ghost_member_id && row.source_present_stripe),
        grants: grants.filter((row) => row.ghost_member_id === member.ghost_member_id && row.source_present_ghost),
        externalFlags: member.profile_status === "review_required" ? ["PROFILE_REVIEW_REQUIRED"] : member.profile_status === "not_submitted" ? ["PROFILE_NOT_SUBMITTED"] : [],
        now,
      });
      return {
        ...member,
        qualifying_entitlement_count: state.qualifyingEntitlementCount,
        ops_flags: state.opsFlags.join(","),
        primary_ops_state: state.primaryOpsState,
      };
    });

    this.checkpoint(cursor, deadlineMs, true);
    this.replaceReconcileTable(cursor, "members", "10_Members", members, memberSweep.tombstoned);
    this.checkpoint(cursor, deadlineMs, true);
    this.replaceReconcileTable(
      cursor,
      "subscriptions",
      "20_Subscriptions",
      subscriptions,
      stripeSweep.tombstoned + ghostProjectionSweep.tombstoned,
    );
    this.checkpoint(cursor, deadlineMs, true);
    this.replaceReconcileTable(cursor, "grants", "21_AccessGrants", grants, grantSweep.tombstoned);

    const findings = findOperationalExceptions({ members, subscriptions, grants, signals, now });
    if (!fullScan && isFullSyncStale(this.deps.properties.getProperty(this.stateKey("LAST_NIGHTLY_SUCCESS_AT")), now)) {
      findings.push({
        exceptionKey: exceptionKey("FULL_SYNC_STALE", this.deps.config.ghostSiteId),
        exceptionType: "FULL_SYNC_STALE",
        severity: "P1",
        summary: "夜間全件照合の最終成功から24時間以上経過しています。",
        immediate: true,
      });
    }
    for (const member of members.filter((row) => row.source_present_ghost && !row.name)) {
      findings.push({
        exceptionKey: exceptionKey("GHOST_NAME_MISSING", member.ghost_member_id),
        exceptionType: "GHOST_NAME_MISSING",
        severity: "P3",
        summary: "Ghost会員の氏名が未入力です。",
        minhosMemberId: member.minhos_member_id,
        ghostMemberId: member.ghost_member_id,
      });
    }

    this.checkpoint(cursor, deadlineMs, true);
    const after = withScriptLock(() => {
      const before = this.deps.repository.read<ExceptionRow>("50_Exceptions");
      let reconciled = reconcileExceptionRows({ existing: before, findings, runId: cursor.runId, nowIso, newId: this.deps.uuid });
      const decisions = planExceptionNotifications({ before, after: reconciled, findings, now });
      this.enqueueNotificationDecisions(decisions, nowIso);
      this.deps.repository.replace("50_Exceptions", reconciled);
      reconciled = this.tryDeliverNotificationOutboxLocked(reconciled, nowIso);
      return reconciled;
    });

    this.checkpoint(cursor, deadlineMs, true);
    this.writeDashboard(members, subscriptions, signals, after, cursor, nowIso);
    this.checkpoint(cursor, deadlineMs);
    this.setStateProperty(this.stateKey("CONSECUTIVE_SYNC_FAILURES"), "0");
    this.setStateProperty(this.stateKey("LAST_SYNC_SUCCESS_AT"), nowIso);
    if (cursor.requestedRunType === "hourly") this.setStateProperty(this.stateKey("LAST_REGULAR_SUCCESS_AT"), nowIso);
    if (fullScan) this.setStateProperty(this.stateKey("LAST_NIGHTLY_SUCCESS_AT"), nowIso);
    this.checkpoint(cursor, deadlineMs, true);
    this.deps.repository.appendSyncLog(this.syncLog(
      cursor,
      true,
      "",
      cursor.stats?.tombstoned ?? 0,
      after.filter((row) => row.status !== "resolved").length,
    ));
    this.deps.coordinator.clearCursor(cursor.runId, this.leaseOwnerId);
    return false;
  }

  /**
   * Retrieve actionable invoices that the completed open-invoice list did not
   * observe. Each item is committed immediately and the cursor is advanced
   * only after that commit. A bounded chunk prevents a large stale-invoice
   * set from monopolising one Apps Script invocation.
   */
  private refreshUnseenOpenInvoiceItems(
    cursor: SyncCursor,
    deadlineMs: number,
    completedFullScan: boolean,
  ): boolean {
    if (!completedFullScan) {
      delete cursor.reconcileInvoiceAfterKey;
      return false;
    }
    const page = planUnseenOpenInvoicePage({
      signals: this.deps.repository.read<BillingSignalRow>("25_BillingSignals"),
      completedFullScan: true,
      runId: cursor.runId,
      ...(cursor.reconcileInvoiceAfterKey ? { afterKey: cursor.reconcileInvoiceAfterKey } : {}),
      limit: RECONCILE_INVOICE_CHUNK_SIZE,
    });
    const nowIso = this.deps.now().toISOString();
    for (const previous of page.rows) {
      this.checkpoint(cursor, deadlineMs);
      if (!previous.invoice_id) throw new Error("SCHEMA_MISMATCH:billing_signal.invoice_id");
      const raw = this.deps.stripe.retrieveInvoice(previous.invoice_id);
      if (raw.id !== previous.invoice_id) throw new Error("STRIPE_OBJECT_ID_MISMATCH:invoice");
      const retrieved = mapInvoiceSignal(raw, { runId: cursor.runId, nowIso });
      if (retrieved.signal_key !== previous.signal_key || retrieved.invoice_id !== previous.invoice_id) {
        throw new Error("STRIPE_SIGNAL_KEY_MISMATCH:invoice");
      }
      this.assertSignalsInScope([retrieved], cursor);
      const refreshed = reconcileRetrievedInvoice(previous, retrieved, nowIso);
      this.checkpoint(cursor, deadlineMs, true);
      this.addUpsertCounts(cursor, this.deps.repository.upsert("25_BillingSignals", [refreshed]));
      this.addBillingRecordStats(cursor, 1);
      // This is the item commit point. If cursor persistence fails, retrying
      // the same upsert is safe because signal_key is the ledger key.
      cursor.reconcileInvoiceAfterKey = previous.signal_key;
      this.deps.coordinator.writeCursor(cursor, this.leaseOwnerId);
      if (this.shouldYield(deadlineMs)) {
        this.pause(cursor);
        return true;
      }
    }
    if (page.hasMore) {
      this.pause(cursor);
      return true;
    }
    delete cursor.reconcileInvoiceAfterKey;
    return false;
  }

  private applyGhostProjections(
    projections: GhostSubscriptionProjection[],
    nowIso: string,
    cursor: SyncCursor,
    deadlineMs: number,
  ): void {
    if (!projections.length) return;
    const subscriptions = this.deps.repository.read<SubscriptionRow>("20_Subscriptions");
    assertSubscriptionIdentityIntegrity(subscriptions, {
      stripeAccountId: this.deps.config.stripeAccountId,
      livemode: this.deps.config.livemode,
    });
    const projectionById = new Map(projections.map((projection) => [projection.stripe_subscription_id, projection]));
    const updates = subscriptions
      .filter((row) => projectionById.has(row.stripe_subscription_id))
      .map((row) => ({
        ...mergeGhostProjection(row, projectionById.get(row.stripe_subscription_id)),
        last_synced_at: nowIso,
      }));
    this.checkpoint(cursor, deadlineMs, true);
    this.addUpsertCounts(cursor, this.deps.repository.upsert("20_Subscriptions", updates, SUBSCRIPTION_GHOST_COLUMNS));
  }

  private finishStripePage(
    cursor: SyncCursor,
    phases: readonly string[],
    deadlineMs: number,
    nextCursor: string | null,
  ): boolean {
    if (nextCursor) {
      cursor.stripeStartingAfter = nextCursor;
      this.deps.coordinator.writeCursor(cursor, this.leaseOwnerId);
      if (this.shouldYield(deadlineMs)) {
        this.pause(cursor);
        return true;
      }
    } else {
      delete cursor.stripeStartingAfter;
      this.advance(cursor, phases);
    }
    return false;
  }

  private stripeScope(): StripeScope {
    return {
      expectedAccountId: this.deps.config.stripeAccountId,
      expectedLivemode: this.deps.config.livemode,
      allowedPriceIds: this.deps.config.stripePriceIds,
      allowedProductIds: this.deps.config.stripeProductIds,
    };
  }

  private assertSignalsInScope(
    signals: BillingSignalRow[],
    cursor: SyncCursor,
    subscriptions = this.deps.repository.read<SubscriptionRow>("20_Subscriptions"),
  ): void {
    assertSubscriptionIdentityIntegrity(subscriptions, {
      stripeAccountId: this.deps.config.stripeAccountId,
      livemode: this.deps.config.livemode,
    });
    const scope = this.stripeScope();
    assertBillingSignalsInScope(signals, subscriptions, { ...scope, runId: cursor.runId });
  }

  private selectLedgerSignals(
    signals: BillingSignalRow[],
    cursor: SyncCursor,
    deadlineMs: number,
  ): BillingSignalRow[] {
    const subscriptions = this.deps.repository.read<SubscriptionRow>("20_Subscriptions");
    assertSubscriptionIdentityIntegrity(subscriptions, {
      stripeAccountId: this.deps.config.stripeAccountId,
      livemode: this.deps.config.livemode,
    });
    const scope = { ...this.stripeScope(), runId: cursor.runId };
    const accepted: BillingSignalRow[] = [];
    for (const signal of signals) {
      const violation = billingSignalScopeViolation(signal, subscriptions, scope);
      if (!violation) {
        accepted.push(signal);
        continue;
      }
      const { finding, unmatched } = billingScopeExceptionFinding(signal, violation);
      this.checkpoint(cursor, deadlineMs, true);
      this.upsertAndNotifySingleFinding(finding, cursor.runId, this.deps.now());
      if (!unmatched) throw new Error(`STRIPE_SCOPE_VIOLATION:${signal.object_type}:${violation}`);
    }
    return accepted;
  }

  private advance(cursor: SyncCursor, phases: readonly string[]): void {
    const index = phases.indexOf(cursor.phase);
    const next = phases[index + 1];
    if (!next) throw new Error(`NO_PHASE_AFTER:${cursor.phase}`);
    cursor.phase = next;
    delete cursor.ghostPage;
    delete cursor.stripeStartingAfter;
    delete cursor.stripeCreatedGte;
    delete cursor.trackedSignalAfterKey;
    delete cursor.reconcileInvoiceAfterKey;
  }

  private phases(runType: Exclude<RunType, "resume">): readonly string[] {
    return runType === "hourly" ? HOURLY_PHASES : FULL_PHASES;
  }

  private pause(cursor: SyncCursor): void {
    this.deps.coordinator.writeCursor(cursor, this.leaseOwnerId);
    this.deps.coordinator.scheduleResume();
  }

  private shouldYield(deadlineMs: number): boolean {
    return isRuntimeBudgetExhausted(this.deps.now().getTime(), deadlineMs);
  }

  private checkpoint(cursor: SyncCursor, deadlineMs: number, forceLeaseRenewal = false): void {
    const nowMs = this.deps.now().getTime();
    if (isRuntimeBudgetExhausted(nowMs, deadlineMs)) throw new SyncYieldRequested();
    if (shouldRenewLease(nowMs, this.lastLeaseRenewedAtMs, forceLeaseRenewal)) {
      this.deps.coordinator.renew(cursor.runId, nowMs, this.leaseOwnerId);
      this.lastLeaseRenewedAtMs = nowMs;
    }
  }

  private newCursor(runType: Exclude<RunType, "resume">): SyncCursor {
    return {
      schemaVersion: this.deps.config.schemaVersion,
      contextFingerprint: syncContextFingerprint(this.deps.config),
      runId: `run_${this.deps.uuid()}`,
      requestedRunType: runType,
      phase: "account",
      startedAt: this.deps.now().toISOString(),
      stats: { ghostPages: 0, ghostRecords: 0, stripePages: 0, stripeRecords: 0, billingPages: 0, billingRecords: 0 },
    };
  }

  private addStats(cursor: SyncCursor, source: "ghost" | "stripe" | "billing", count: number): void {
    const stats = cursor.stats ?? { ghostPages: 0, ghostRecords: 0, stripePages: 0, stripeRecords: 0, billingPages: 0, billingRecords: 0 };
    if (source === "ghost") { stats.ghostPages += 1; stats.ghostRecords += count; }
    if (source === "stripe") { stats.stripePages += 1; stats.stripeRecords += count; }
    if (source === "billing") { stats.billingPages += 1; stats.billingRecords += count; }
    cursor.stats = stats;
  }

  private addBillingPageStats(cursor: SyncCursor): void {
    const stats = cursor.stats ?? { ghostPages: 0, ghostRecords: 0, stripePages: 0, stripeRecords: 0, billingPages: 0, billingRecords: 0 };
    stats.billingPages += 1;
    cursor.stats = stats;
  }

  private addBillingRecordStats(cursor: SyncCursor, count: number): void {
    const stats = cursor.stats ?? { ghostPages: 0, ghostRecords: 0, stripePages: 0, stripeRecords: 0, billingPages: 0, billingRecords: 0 };
    stats.billingRecords += count;
    cursor.stats = stats;
  }

  private addUpsertCounts(
    cursor: SyncCursor,
    counts: { inserted: number; updated: number; unchanged: number },
  ): void {
    const stats = cursor.stats ?? { ghostPages: 0, ghostRecords: 0, stripePages: 0, stripeRecords: 0, billingPages: 0, billingRecords: 0 };
    stats.inserted = (stats.inserted ?? 0) + counts.inserted;
    stats.updated = (stats.updated ?? 0) + counts.updated;
    stats.unchanged = (stats.unchanged ?? 0) + counts.unchanged;
    cursor.stats = stats;
  }

  /**
   * Persist a write-ahead tombstone delta, replace one Sheet idempotently,
   * then commit the delta. If the replace or post-mutation cursor write is
   * uncertain, the durable pending marker survives generic failure cleanup
   * and a resumed owner repeats this table without double-counting.
   */
  private replaceReconcileTable<T extends SheetRecord>(
    cursor: SyncCursor,
    table: ReconcileTombstoneTable,
    sheetName: string,
    rows: T[],
    observedDelta: number,
  ): void {
    const existing = cursor.reconcileTombstoneCommit;
    const targetOrder = RECONCILE_TOMBSTONE_TABLE_ORDER[table];
    if (existing) {
      const existingOrder = RECONCILE_TOMBSTONE_TABLE_ORDER[existing.table];
      if (existingOrder > targetOrder || (existingOrder === targetOrder && existing.state === "committed")) {
        return;
      }
    }

    const stats = cursor.stats ?? {
      ghostPages: 0,
      ghostRecords: 0,
      stripePages: 0,
      stripeRecords: 0,
      billingPages: 0,
      billingRecords: 0,
    };
    cursor.stats = stats;

    const pending = existing?.table === table && existing.state === "pending"
      ? existing
      : {
        table,
        state: "pending" as const,
        baseTombstoned: stats.tombstoned ?? 0,
        deltaTombstoned: observedDelta,
      };

    if (pending !== existing) {
      cursor.reconcileTombstoneCommit = pending;
      this.writeReconcileCursor(cursor);
    }

    try {
      this.deps.repository.replace(sheetName, rows);
    } catch (error) {
      if (error instanceof RunLeaseFenced) throw error;
      throw new ReconcileCommitRetryRequested();
    }

    stats.tombstoned = pending.baseTombstoned + pending.deltaTombstoned;
    cursor.reconcileTombstoneCommit = { ...pending, state: "committed" };
    this.writeReconcileCursor(cursor);
  }

  private writeReconcileCursor(cursor: SyncCursor): void {
    try {
      this.deps.coordinator.writeCursor(cursor, this.leaseOwnerId);
    } catch (error) {
      if (error instanceof RunLeaseFenced) throw error;
      throw new ReconcileCommitRetryRequested();
    }
  }

  private billingWatermark(kind: "REFUND" | "DISPUTE", now: Date): number {
    const stored = Number(this.deps.properties.getProperty(this.stateKey(`${kind}_WATERMARK_UNIX`)) ?? 0);
    const defaultStart = Math.floor(now.getTime() / 1000) - 90 * 86_400;
    return Math.max(0, (stored || defaultStart) - this.deps.config.watermarkOverlapSeconds);
  }

  /**
   * Pin an incremental Refund/Dispute lower bound before the first list
   * request. Recomputing it on every resumed invocation can move the window
   * and make a partially completed page impossible to reason about.
   */
  private pinnedBillingLowerBound(
    cursor: SyncCursor,
    kind: "REFUND" | "DISPUTE",
    deadlineMs: number,
  ): number {
    if (cursor.stripeCreatedGte !== undefined) {
      if (cursor.stripeCreatedGte === null) {
        throw new Error(`INVALID_SYNC_CURSOR:${kind.toLowerCase()}_created_gte`);
      }
      return cursor.stripeCreatedGte;
    }
    const lowerBound = this.billingWatermark(kind, this.deps.now());
    this.checkpoint(cursor, deadlineMs, true);
    cursor.stripeCreatedGte = lowerBound;
    this.deps.coordinator.writeCursor(cursor, this.leaseOwnerId);
    return lowerBound;
  }

  /**
   * The first Dispute history scan must remain unbounded. Persisting `null`
   * distinguishes that intentional mode from an unpinned incremental scan.
   */
  private pinInitialDisputeHistory(cursor: SyncCursor, deadlineMs: number): undefined {
    if (cursor.stripeCreatedGte === undefined) {
      this.checkpoint(cursor, deadlineMs, true);
      cursor.stripeCreatedGte = null;
      this.deps.coordinator.writeCursor(cursor, this.leaseOwnerId);
    } else if (cursor.stripeCreatedGte !== null) {
      throw new Error("INVALID_SYNC_CURSOR:dispute_history_lower_bound");
    }
    return undefined;
  }

  private recordFailure(cursor: SyncCursor, error: unknown): void {
    const now = this.deps.now();
    const nowIso = now.toISOString();
    const count = Number(this.deps.properties.getProperty(this.stateKey("CONSECUTIVE_SYNC_FAILURES")) ?? 0) + 1;
    this.setStateProperty(this.stateKey("CONSECUTIVE_SYNC_FAILURES"), String(count));
    const finding = failureFinding(error, count, this.deps.config.ghostSiteId);
    if (finding) this.upsertAndNotifySingleFinding(finding, cursor.runId, now);
    this.deps.repository.upsertOwnedRowsInPlace("00_Dashboard", [{
      metric: "last_sync_result",
      value: "failed",
      updated_at: nowIso,
      description: "直近同期結果",
    }], ["value", "updated_at", "description"]);
    this.deps.repository.appendSyncLog(this.syncLog(cursor, false, redactSecrets(errorSummary(error)), 0, 0, nowIso));
  }

  private recordCursorQuarantine(cursor: SyncCursor, reason: string): void {
    const now = this.deps.now();
    const quarantineRunId = `cursor_quarantine_${this.deps.uuid()}`;
    this.upsertAndNotifySingleFinding({
      exceptionKey: exceptionKey("SYNC_CURSOR_QUARANTINED", cursor.contextFingerprint),
      exceptionType: "SYNC_CURSOR_QUARANTINED",
      severity: "P1",
      summary: "不正または設定不一致の同期cursorを隔離し、新しい安全なrunへ切り替えました。",
      immediate: true,
    }, quarantineRunId, now);
    this.deps.repository.appendSyncLog(this.syncLog(
      { ...cursor, runId: quarantineRunId },
      false,
      redactSecrets(`SYNC_CURSOR_QUARANTINED:${reason}`),
      0,
      0,
      now.toISOString(),
    ));
  }

  private upsertAndNotifySingleFinding(finding: ExceptionFinding, runId: string, now: Date): void {
    withScriptLock(() => {
      const all = this.deps.repository.read<ExceptionRow>("50_Exceptions");
      const previous = all.find((row) => row.exception_key === finding.exceptionKey);
      // A crash after the exception Sheet write but before the item cursor
      // write replays the same billing object. Do not count that replay as a
      // second observation within the same run.
      if (previous?.related_sync_run_id === runId) {
        this.tryDeliverNotificationOutboxLocked(all, now.toISOString());
        return;
      }
      const next = reconcileExceptionRows({
        existing: previous ? [previous] : [],
        findings: [finding],
        runId,
        nowIso: now.toISOString(),
        newId: this.deps.uuid,
      })[0];
      if (!next) return;
      const decisions = planExceptionNotifications({ before: previous ? [previous] : [], after: [next], findings: [finding], now });
      this.enqueueNotificationDecisions(decisions, now.toISOString());
      this.deps.repository.upsert("50_Exceptions", [next]);
      const rows = all.map((row) => row.exception_key === next.exception_key ? next : row);
      if (!previous) rows.push(next);
      this.tryDeliverNotificationOutboxLocked(rows, now.toISOString());
    });
  }

  private flushPendingNotifications(nowIso: string): void {
    withScriptLock(() => {
      const rows = this.deps.repository.read<ExceptionRow>("50_Exceptions");
      this.tryDeliverNotificationOutboxLocked(rows, nowIso);
    });
  }

  private enqueueNotificationDecisions(
    decisions: ReturnType<typeof planExceptionNotifications>,
    nowIso: string,
  ): void {
    if (!decisions.length) return;
    const outbox = this.readNotificationOutbox(nowIso);
    const existingIds = new Set(outbox.map((item) => item.notificationId));
    const next = enqueueNotificationOutbox(outbox, decisions, nowIso);
    this.persistNotificationOutboxItems(next.filter((item) => !existingIds.has(item.notificationId)));
  }

  /**
   * Must be called under the shared script lock. Mail failure leaves every
   * item pending. After Mail succeeds, `sent` is persisted before the Sheet
   * acknowledgement, so a Sheet failure retries only the acknowledgement.
   */
  private tryDeliverNotificationOutboxLocked(rows: ExceptionRow[], nowIso: string): ExceptionRow[] {
    // Repair/quarantine is deliberately outside the delivery catch below.
    // A failed quarantine write must fail closed and leave the corrupt source
    // in place; mail/Sheet failures retain the existing retry contract.
    let outbox = this.readNotificationOutbox(nowIso);
    if (!outbox.length) return rows;
    let updatedRows = rows;

    try {
      const priorSent = planNotificationOutboxDelivery({ outbox, rows: updatedRows }).sentItems;
      if (priorSent.length) {
        updatedRows = this.acknowledgeNotificationItems(updatedRows, priorSent, nowIso);
        outbox = completeNotificationOutboxItems(outbox, priorSent);
        this.deleteNotificationOutboxItems(priorSent);
      }

      const plan = planNotificationOutboxDelivery({ outbox, rows: updatedRows });
      if (!plan.decisions.length) return updatedRows;
      this.sendNotifications(plan.decisions, plan.deliverItems);
      outbox = markNotificationOutboxSent(outbox, plan.deliverItems);
      const deliveredIds = new Set(plan.deliverItems.map((item) => item.notificationId));
      this.persistNotificationOutboxItems(outbox.filter((item) => deliveredIds.has(item.notificationId)));
      updatedRows = this.acknowledgeNotificationItems(updatedRows, plan.deliverItems, nowIso);
      this.deleteNotificationOutboxItems(plan.deliverItems);
      return updatedRows;
    } catch {
      // The persisted state (pending or sent) is the retry contract. A mail or
      // Sheet failure must not roll back exception reconciliation or drop work.
      return updatedRows;
    }
  }

  private acknowledgeNotificationItems(
    rows: ExceptionRow[],
    items: NotificationOutboxItem[],
    nowIso: string,
  ): ExceptionRow[] {
    const decisions = notificationDecisionsForItems(items, rows);
    const updated = markNotificationsSent(rows, decisions, nowIso);
    const keys = new Set(decisions.map((decision) => decision.exceptionKey));
    this.deps.repository.upsert("50_Exceptions", updated.filter((row) => keys.has(row.exception_key)));
    return updated;
  }

  private readNotificationOutbox(nowIso: string): NotificationOutboxItem[] {
    return repairNotificationOutboxProperties(
      this.deps.properties,
      syncContextFingerprint(this.deps.config),
      nowIso,
    );
  }

  private persistNotificationOutboxItems(items: NotificationOutboxItem[]): void {
    for (const item of items) {
      this.setStateProperty(
        this.stateKey(`NOTIFICATION_OUTBOX_JSON:${item.notificationId}`),
        serializeNotificationOutboxItem(item),
      );
    }
  }

  private deleteNotificationOutboxItems(items: NotificationOutboxItem[]): void {
    for (const item of items) {
      this.deps.properties.deleteProperty(this.stateKey(`NOTIFICATION_OUTBOX_JSON:${item.notificationId}`));
    }
  }

  private sendNotifications(
    decisions: ReturnType<typeof planExceptionNotifications>,
    items: NotificationOutboxItem[],
  ): ReturnType<typeof planExceptionNotifications> {
    const delivered = notificationDeliveryBatch(decisions);
    const lines = delivered.map((item, index) =>
      `[${item.severity}] ${item.kind} ${item.exceptionKey} (${items[index]?.notificationId ?? "no-id"}): ${item.summary}`,
    );
    this.deps.sendMail(
      this.deps.config.notificationEmail,
      `[みんほす] 同期・照合通知 ${delivered.length}件`,
      [`Ghost/Stripe/Sheetsの運用例外が変化しました。`, "", ...lines, "", "カード情報・API秘密鍵は通知に含めていません。"].join("\n"),
    );
    return delivered;
  }

  private writeDashboard(
    members: MemberRow[],
    subscriptions: SubscriptionRow[],
    signals: BillingSignalRow[],
    exceptions: ExceptionRow[],
    cursor: SyncCursor,
    nowIso: string,
  ): void {
    const activeExceptions = exceptions.filter((row) => row.status === "open" || row.status === "acknowledged");
    const presentMembers = members.filter((row) => row.source_present_ghost);
    const presentSubscriptions = subscriptions.filter((row) => row.source_present_stripe);
    const registered = presentMembers.length;
    const configRows = this.deps.repository.read<SheetRecord>("99_Config");
    const supplementalRows = this.deps.repository.read<SheetRecord>("40_Supplemental");
    const profileReviewIds = new Set([
      ...presentMembers.filter((row) => row.profile_status === "review_required").map((row) => row.minhos_member_id),
      ...supplementalRows
        .filter((row) => row.verification_status === "unverified" || row.verification_status === "review_required")
        .map((row) => String(row.minhos_member_id ?? ""))
        .filter(Boolean),
    ]);
    const staffCount = dashboardManualCount(configRows, "GHOST_STAFF_COUNT_MANUAL");
    const pendingCount = dashboardManualCount(configRows, "GHOST_PENDING_INVITATION_COUNT_MANUAL");
    const staffAndPending = typeof staffCount === "number" && typeof pendingCount === "number"
      ? staffCount + pendingCount
      : "not_configured";
    const fullScan = cursor.requestedRunType === "nightly" || cursor.requestedRunType === "manual";
    const previousRegular = this.deps.properties.getProperty(this.stateKey("LAST_REGULAR_SUCCESS_AT")) ?? "";
    const previousFull = this.deps.properties.getProperty(this.stateKey("LAST_NIGHTLY_SUCCESS_AT")) ?? "";
    this.deps.repository.writeDashboard([
      { metric: "ghost_registered_members", value: registered, description: "Ghost登録会員総数" },
      { metric: "ghost_paid_access_members", value: presentMembers.filter((row) => row.ghost_access_state === "paid").length, description: "Ghost有料アクセス会員" },
      { metric: "ghost_free_or_no_access_members", value: presentMembers.filter((row) => row.ghost_access_state !== "paid").length, description: "Ghost無料・権利なし会員" },
      { metric: "stripe_nonterminal_subscriptions", value: presentSubscriptions.filter((row) => !["canceled", "incomplete_expired"].includes(row.stripe_status)).length, description: "Stripe非終端契約" },
      { metric: "stripe_past_due_subscriptions", value: presentSubscriptions.filter((row) => row.stripe_status === "past_due").length, description: "Stripe past_due" },
      { metric: "stripe_unpaid_subscriptions", value: presentSubscriptions.filter((row) => row.stripe_status === "unpaid").length, description: "Stripe unpaid" },
      { metric: "stripe_paused_subscriptions", value: presentSubscriptions.filter((row) => row.stripe_status === "paused").length, description: "Stripe paused" },
      { metric: "stripe_pause_collection_subscriptions", value: presentSubscriptions.filter((row) => Boolean(row.pause_collection_behavior)).length, description: "pause_collection設定契約" },
      { metric: "stripe_open_invoice_count", value: signals.filter((row) => row.object_type === "invoice" && row.needs_action).length, description: "未解決open Invoice" },
      { metric: "cancel_at_period_end_subscriptions", value: presentSubscriptions.filter((row) => row.cancel_at_period_end).length, description: "期間末解約予約" },
      { metric: "duplicate_subscription_members", value: activeExceptions.filter((row) => row.exception_type === "DUPLICATE_SUBSCRIPTION").length, description: "重複Subscription会員" },
      { metric: "open_disputes", value: signals.filter((row) => row.object_type === "dispute" && row.needs_action).length, description: "未解決Dispute" },
      { metric: "profile_not_submitted", value: presentMembers.filter((row) => row.profile_status === "not_submitted").length, description: "Form取込済みデータに基づく未回答" },
      { metric: "profile_review_required", value: profileReviewIds.size, description: "プロフィール要確認（未検証Supplementalを含む）" },
      { metric: "open_p1_exceptions", value: activeExceptions.filter((row) => row.severity === "P1").length, description: "未解決P1" },
      { metric: "open_p2_exceptions", value: activeExceptions.filter((row) => row.severity === "P2").length, description: "未解決P2" },
      { metric: "last_regular_sync_success", value: cursor.requestedRunType === "hourly" ? nowIso : previousRegular, description: "最終通常同期成功（UTC）" },
      { metric: "last_full_sync_success", value: fullScan ? nowIso : previousFull, description: "最終全件照合成功（UTC）" },
      { metric: "last_sync_result", value: "success", description: "直近同期結果" },
      { metric: "publisher_member_utilization_percent", value: Number(((registered / 1000) * 100).toFixed(1)), description: "Publisher基本料金帯1,000登録会員に対する使用率" },
      { metric: "publisher_warning_800", value: String(registered >= 800), description: "Ghost登録会員800人警告" },
      { metric: "publisher_warning_900", value: String(registered >= 900), description: "Ghost登録会員900人警告" },
      { metric: "ghost_staff_count", value: staffCount, description: "99_Configの手動確認staff数（未設定はnot_configured）" },
      { metric: "ghost_pending_invitation_count", value: pendingCount, description: "99_Configの手動確認pending invitation数（未設定はnot_configured）" },
      { metric: "ghost_staff_and_pending_total", value: staffAndPending, description: "staffとpending invitationの合計" },
    ], nowIso);
  }

  private setStateProperty(name: string, value: string): void {
    assertSafePropertyStoreWrites(
      this.deps.properties.getProperties(),
      [{ name, value }],
      "SYNC_SCRIPT_PROPERTY",
    );
    this.deps.properties.setProperty(name, value);
  }

  private stateKey(name: string): string {
    return `${name}:${syncContextFingerprint(this.deps.config)}`;
  }

  private syncLog(
    cursor: SyncCursor,
    completed: boolean,
    errorSummaryValue: string,
    tombstoned: number,
    exceptionCount: number,
    finishedAt = this.deps.now().toISOString(),
  ): SheetRecord {
    const stats = cursor.stats ?? { ghostPages: 0, ghostRecords: 0, stripePages: 0, stripeRecords: 0, billingPages: 0, billingRecords: 0 };
    return {
      run_id: cursor.runId,
      run_type: cursor.requestedRunType,
      started_at: cursor.startedAt,
      finished_at: finishedAt,
      environment: this.deps.config.livemode ? "live" : "test",
      ghost_pages: stats.ghostPages,
      stripe_pages: stats.stripePages + stats.billingPages,
      counts: JSON.stringify({
        ghost_records: stats.ghostRecords,
        stripe_subscription_records: stats.stripeRecords,
        billing_signal_records: stats.billingRecords,
        upsert_inserted: stats.inserted ?? 0,
        upsert_updated: stats.updated ?? 0,
        upsert_unchanged: stats.unchanged ?? 0,
        tombstoned,
        attempts: cursor.attempts ?? [],
      }),
      exception_count: exceptionCount,
      completed,
      cursor: completed ? "" : JSON.stringify({
        phase: cursor.phase,
        ghostPage: cursor.ghostPage ?? "",
        stripeStartingAfter: cursor.stripeStartingAfter ?? "",
        stripeCreatedGte: cursor.stripeCreatedGte ?? null,
        trackedSignalAfterKey: cursor.trackedSignalAfterKey ?? "",
        reconcileInvoiceAfterKey: cursor.reconcileInvoiceAfterKey ?? "",
      }),
      error_summary: errorSummaryValue,
      code_version: this.deps.config.codeVersion,
    };
  }
}

function countOpenInvoices(signals: BillingSignalRow[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const signal of signals.filter((row) => row.object_type === "invoice" && row.needs_action && row.stripe_subscription_id)) {
    result.set(signal.stripe_subscription_id, (result.get(signal.stripe_subscription_id) ?? 0) + 1);
  }
  return result;
}

function successfulRefundTotalsByCharge(refunds: StripeRefundRaw[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const refund of refunds) {
    if (refund.status !== "succeeded") continue;
    const chargeId = idOf(refund.charge);
    if (!chargeId) continue;
    totals.set(chargeId, (totals.get(chargeId) ?? 0) + refund.amount);
  }
  return totals;
}

function isFullSyncStale(lastSuccess: string | null, now: Date): boolean {
  if (!lastSuccess) return true;
  const parsed = Date.parse(lastSuccess);
  return !Number.isFinite(parsed) || now.getTime() - parsed >= 24 * 60 * 60 * 1000;
}

function failureFinding(error: unknown, consecutiveFailures: number, siteId: string): ExceptionFinding | null {
  const summary = errorSummary(error);
  if (error instanceof HttpFailure && (error.status === 401 || error.status === 403)) {
    return { exceptionKey: exceptionKey("SYNC_AUTHENTICATION_FAILED", siteId), exceptionType: "SYNC_AUTHENTICATION_FAILED", severity: "P1", summary: "GhostまたはStripeのAPI認証に失敗しました。", immediate: true };
  }
  if (summary.includes("SCHEMA_MISMATCH")) {
    return { exceptionKey: exceptionKey("SYNC_SCHEMA_MISMATCH", siteId), exceptionType: "SYNC_SCHEMA_MISMATCH", severity: "P1", summary: "外部APIのレスポンス形式が期待と一致しません。", immediate: true };
  }
  if (summary.includes("MISMATCH") || summary.includes("OUTSIDE_ALLOWLIST") || summary.includes("SCOPE_VIOLATION")) {
    return { exceptionKey: exceptionKey("SYNC_ENVIRONMENT_BOUNDARY", siteId), exceptionType: "SYNC_ENVIRONMENT_BOUNDARY", severity: "P1", summary: "StripeのAccount・環境・Product・Price境界が一致しません。", immediate: true };
  }
  if (consecutiveFailures >= 3) {
    return { exceptionKey: exceptionKey("SYNC_CONSECUTIVE_FAILURES", siteId), exceptionType: "SYNC_CONSECUTIVE_FAILURES", severity: "P2", summary: `${consecutiveFailures}回連続で同期に失敗しました。`, immediate: true };
  }
  return null;
}

function dashboardManualCount(rows: SheetRecord[], key: string): number | "not_configured" {
  const raw = rows.find((row) => row.config_key === key)?.config_value_non_secret;
  if (raw === "" || raw === null || raw === undefined) return "not_configured";
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : "not_configured";
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? `${error.name}:${error.message}` : String(error);
}

function isRetryable(error: unknown): boolean {
  return error instanceof HttpFailure && error.retryable;
}
