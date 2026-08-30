import { describe, expect, it } from "vitest";
import { assertBillingSignalsInScope, billingScopeExceptionFinding } from "../src/domain/billing-scope";
import { disputeScanLowerBound, planUnseenOpenInvoicePage, reconcileRetrievedInvoice, refreshUnseenOpenInvoiceSignals, unseenOpenInvoiceSignals } from "../src/domain/billing-signal-lifecycle";
import { findOperationalExceptions, reconcileExceptionRows } from "../src/domain/exceptions";
import { shouldCreateResumeTrigger } from "../src/domain/resume-trigger";
import { isRuntimeBudgetExhausted, shouldRenewLease } from "../src/domain/runtime-budget";
import { LookupCache } from "../src/domain/lookup-cache";
import type { AccessGrantRow, BillingSignalRow, MemberRow, SubscriptionRow } from "../src/domain/types";

const nowIso = "2026-08-28T00:00:00.000Z";

describe("Stripe scope containment", () => {
  it("accepts signals only when they resolve to an allowlisted subscription observed in this run", () => {
    const current = subscription("sub_current", "active");
    const scope = {
      runId: "run_current",
      expectedAccountId: "acct",
      expectedLivemode: false,
      allowedPriceIds: new Set(["price"]),
      allowedProductIds: new Set(["prod"]),
    };
    expect(() => assertBillingSignalsInScope(
      [signal("invoice", "sub_current")],
      [current],
      scope,
    )).not.toThrow();

    for (const outOfScope of [
      signal("invoice", ""),
      signal("refund", "sub_other"),
      signal("dispute", "sub_other"),
    ]) {
      expect(() => assertBillingSignalsInScope([outOfScope], [current], scope)).toThrow(/STRIPE_SCOPE_VIOLATION/);
    }
    expect(() => assertBillingSignalsInScope(
      [signal("invoice", "sub_current")],
      [{ ...current, source_present_stripe: false }],
      scope,
    )).toThrow(/SUBSCRIPTION_OUTSIDE_CURRENT_SCAN/);
  });

  it("persists unmatched Refund/Dispute as an actionable quarantine exception", () => {
    for (const objectType of ["refund", "dispute"] as const) {
      const unmatchedSignal = { ...signal(objectType, ""), raw_status: objectType === "refund" ? "succeeded" : "needs_response" };
      const quarantine = billingScopeExceptionFinding(unmatchedSignal, "SUBSCRIPTION_UNRESOLVED");
      expect(quarantine.unmatched).toBe(true);
      expect(quarantine.finding).toMatchObject({
        exceptionType: "UNMATCHED_BILLING_SIGNAL",
        severity: objectType === "dispute" ? "P1" : "P2",
      });
      const persisted = reconcileExceptionRows({
        existing: [], findings: [quarantine.finding], runId: "run_current", nowIso, newId: () => `ex_${objectType}`,
      });
      expect(persisted[0]).toMatchObject({ status: "open", occurrence_count: 1 });
      const afterNoFinding = reconcileExceptionRows({
        existing: persisted, findings: [], runId: "run_next", nowIso: "2026-08-29T00:00:00.000Z", newId: () => "unused",
      });
      expect(afterNoFinding[0]).toMatchObject({ status: "open", exception_id: `ex_${objectType}` });
    }
  });
});

describe("open Invoice lifecycle", () => {
  it("requires retrieval and resolves only authoritative paid/void statuses", () => {
    const stale = signal("invoice", "sub_current");
    expect(unseenOpenInvoiceSignals({ signals: [stale], completedFullScan: false, runId: "run_current" })).toEqual([]);
    expect(unseenOpenInvoiceSignals({ signals: [stale], completedFullScan: true, runId: "run_current" })).toEqual([stale]);
    expect(unseenOpenInvoiceSignals({
      signals: [{ ...stale, last_seen_run_id: "run_current" }], completedFullScan: true, runId: "run_current",
    })).toEqual([]);

    for (const rawStatus of ["open", "uncollectible", "draft"]) {
      const refreshed = reconcileRetrievedInvoice(stale, { ...stale, raw_status: rawStatus, last_seen_run_id: "run_current" }, nowIso);
      expect(refreshed).toMatchObject({ raw_status: rawStatus, needs_action: true, resolved_at: "" });
    }
    for (const rawStatus of ["paid", "void"]) {
      const refreshed = reconcileRetrievedInvoice(stale, { ...stale, raw_status: rawStatus, last_seen_run_id: "run_current" }, nowIso);
      expect(refreshed).toMatchObject({ raw_status: rawStatus, needs_action: false, resolved_at: nowIso });
    }

    const retrievedIds: string[] = [];
    const refreshedRows = refreshUnseenOpenInvoiceSignals({
      signals: [stale], completedFullScan: true, runId: "run_current", nowIso,
      retrieveById: (invoiceId) => {
        retrievedIds.push(invoiceId);
        return { ...stale, raw_status: "uncollectible", last_seen_run_id: "run_current" };
      },
    });
    expect(retrievedIds).toEqual([stale.invoice_id]);
    expect(refreshedRows[0]).toMatchObject({ raw_status: "uncollectible", needs_action: true });
  });

  it("plans 100 unseen invoices in deterministic bounded chunks without overlap", () => {
    const signals = Array.from({ length: 100 }, (_, index) => ({
      ...signal("invoice", `sub_${index}`),
      signal_key: `stripe:invoice:in_${String(index + 1).padStart(3, "0")}`,
      invoice_id: `in_${String(index + 1).padStart(3, "0")}`,
      stripe_subscription_id: "sub_current",
      last_seen_run_id: "run_previous",
    }));
    const seen: string[] = [];
    let afterKey: string | undefined;
    while (true) {
      const page = planUnseenOpenInvoicePage({
        signals, completedFullScan: true, runId: "run_current", ...(afterKey ? { afterKey } : {}), limit: 10,
      });
      page.rows.forEach((row) => seen.push(row.invoice_id));
      if (!page.hasMore) break;
      afterKey = page.rows[page.rows.length - 1]!.signal_key;
    }
    expect(seen).toHaveLength(100);
    expect(new Set(seen).size).toBe(100);
    expect(seen).toEqual(signals.map((row) => row.invoice_id).sort());
  });
});

describe("Dispute history boundary", () => {
  it("uses no 90-day lower bound before the first complete history scan", () => {
    expect(disputeScanLowerBound(false, 1_700_000_000)).toBeUndefined();
    expect(disputeScanLowerBound(true, 1_700_000_000)).toBe(1_700_000_000);
  });
});

describe("source-presence-aware exceptions", () => {
  it("excludes tombstoned Stripe rows from status and duplicate checks", () => {
    const present = subscription("sub_present", "active");
    const missing = { ...subscription("sub_missing", "unpaid"), source_present_stripe: false };
    const findings = findOperationalExceptions({
      members: [member("free")],
      subscriptions: [present, missing],
      grants: [],
      signals: [],
      now: new Date(nowIso),
    });
    expect(findings.map(({ exceptionType }) => exceptionType)).not.toContain("PAYMENT_UNPAID");
    expect(findings.map(({ exceptionType }) => exceptionType)).not.toContain("DUPLICATE_SUBSCRIPTION");
  });

  it("detects Ghost paid access with only a tombstoned subscription and expired grant", () => {
    const tombstoned = { ...subscription("sub_old", "active"), source_present_stripe: false };
    const expired: AccessGrantRow = {
      grant_key: "grant", minhos_member_id: "mm_1", ghost_member_id: "gm_1", tier_id: "tier",
      grant_kind: "comped", starts_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-02-01T00:00:00.000Z",
      grant_reason: "", approved_by: "", source_present_ghost: true, source_missing_since: "",
      last_seen_ghost_run_id: "run_current", last_synced_at: nowIso,
    };
    const findings = findOperationalExceptions({
      members: [member("paid")], subscriptions: [tombstoned], grants: [expired], signals: [], now: new Date(nowIso),
    });
    expect(findings.map(({ exceptionType }) => exceptionType)).toContain("GHOST_ACCESS_WITHOUT_BILLING");
  });

  it("fails closed on unknown Stripe status, send_invoice, and missing grant approval metadata", () => {
    const unsafe = {
      ...subscription("sub_unsafe", "unknown"),
      collection_method: "send_invoice",
    };
    const grant: AccessGrantRow = {
      grant_key: "ghost:site:gm_1:tier:gift", minhos_member_id: "mm_1", ghost_member_id: "gm_1", tier_id: "tier",
      grant_kind: "gift", starts_at: "", expires_at: "", grant_reason: "", approved_by: "",
      source_present_ghost: true, source_missing_since: "", last_seen_ghost_run_id: "run_current", last_synced_at: nowIso,
    };
    const findings = findOperationalExceptions({
      members: [member("paid")], subscriptions: [unsafe], grants: [grant], signals: [], now: new Date(nowIso),
    });
    expect(findings.map(({ exceptionType }) => exceptionType)).toEqual(expect.arrayContaining([
      "STRIPE_STATUS_UNKNOWN", "SEND_INVOICE_UNSUPPORTED", "GRANT_APPROVAL_METADATA_MISSING",
    ]));
  });

  it("creates an operator-actionable exception for a successful full refund signal", () => {
    const successfulFullRefund = {
      ...signal("refund", "sub_current"),
      raw_status: "succeeded",
      signal_kind: "full_or_unknown_refund",
      needs_action: true,
    };
    const findings = findOperationalExceptions({
      members: [member("free")], subscriptions: [subscription("sub_current", "active")], grants: [],
      signals: [successfulFullRefund], now: new Date(nowIso),
    });
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ exceptionType: "REFUND_REVIEW_REQUIRED", severity: "P2" }),
    ]));
  });
});

describe("one-shot resume trigger planning", () => {
  it("ignores the executing trigger and still creates its successor after re-yield", () => {
    const current = { handlerFunction: "resumeSync", uniqueId: "trigger_current" };
    const future = { handlerFunction: "resumeSync", uniqueId: "trigger_future" };
    expect(shouldCreateResumeTrigger([current], "trigger_current")).toBe(true);
    expect(shouldCreateResumeTrigger([current, future], "trigger_current")).toBe(false);
    expect(shouldCreateResumeTrigger([future], "trigger_current")).toBe(false);
    expect(shouldCreateResumeTrigger([], "trigger_current")).toBe(true);
  });

  it("does not let a wrong-source same-handler trigger suppress an exact CLOCK retry", () => {
    const wrong = {
      handlerFunction: "retryProfileFormSubmissions", uniqueId: "wrong",
      eventType: "ON_FORM_SUBMIT", triggerSource: "FORMS", triggerSourceId: "form_1",
    };
    const exact = {
      handlerFunction: "retryProfileFormSubmissions", uniqueId: "future",
      eventType: "CLOCK", triggerSource: "CLOCK", triggerSourceId: "",
    };
    const constraint = { eventType: "CLOCK", triggerSource: "CLOCK", triggerSourceId: "" };
    expect(shouldCreateResumeTrigger([wrong], undefined, "retryProfileFormSubmissions", constraint)).toBe(true);
    expect(shouldCreateResumeTrigger([wrong, exact], undefined, "retryProfileFormSubmissions", constraint)).toBe(false);
    expect(shouldCreateResumeTrigger([exact], "future", "retryProfileFormSubmissions", constraint)).toBe(true);
  });
});

describe("shared billing lookup budget", () => {
  it("loads one shared object only once across 1000 records", () => {
    const cache = new LookupCache<{ id: string }>();
    let requests = 0;
    const values = Array.from({ length: 1000 }, () => cache.getOrLoad("shared", (id) => {
      requests += 1;
      return { id };
    }));
    expect(requests).toBe(1);
    expect(new Set(values).size).toBe(1);
  });
});

describe("Apps Script runtime fencing budget", () => {
  it("reserves shutdown time and renews periodically or immediately before a write", () => {
    const deadline = 300_000;
    expect(isRuntimeBudgetExhausted(284_999, deadline)).toBe(false);
    expect(isRuntimeBudgetExhausted(285_000, deadline)).toBe(true);
    expect(shouldRenewLease(100_000, 0)).toBe(true);
    expect(shouldRenewLease(110_000, 100_000)).toBe(false);
    expect(shouldRenewLease(130_000, 100_000)).toBe(true);
    expect(shouldRenewLease(110_000, 100_000, true)).toBe(true);
  });
});

function subscription(id: string, status: SubscriptionRow["stripe_status"]): SubscriptionRow {
  return {
    subscription_row_key: `stripe:acct:false:${id}`, environment: "test", livemode: false, stripe_account_id: "acct",
    stripe_subscription_id: id, stripe_customer_id: "cus_1", ghost_member_id: "gm_1", minhos_member_id: "mm_1",
    stripe_product_id: "prod", stripe_price_id: "price", ghost_price_id: "", ghost_tier_id: "", tier_name: "",
    unit_amount_minor: 5500, currency: "jpy", billing_interval: "month", stripe_status: status,
    ghost_projected_status: "", status_match: "match", collection_method: "charge_automatically",
    pause_collection_behavior: "", cancel_at_period_end: false, start_date: "", current_period_start: "",
    current_period_end: "", canceled_at: "", ended_at: "", latest_invoice_id: "", latest_invoice_status: "",
    open_invoice_count: 0, last_invoice_paid_at: "", last_payment_failure_at: "", source_present_stripe: true,
    source_present_ghost: true, source_missing_since: "", last_seen_stripe_run_id: "run_current",
    last_seen_ghost_run_id: "run_current", last_synced_at: nowIso,
  };
}

function member(access: MemberRow["ghost_access_state"]): MemberRow {
  return {
    member_row_key: "ghost:site:gm_1", minhos_member_id: "mm_1", ghost_site_id: "site", ghost_member_id: "gm_1",
    member_uuid: "uuid", email: "member@example.invalid", name: "Member", ghost_member_status: access,
    ghost_access_state: access, tier_ids: "tier", stripe_customer_ids: "cus_1", stripe_customer_count: 1,
    qualifying_entitlement_count: 0, profile_status: "not_submitted", ops_flags: "", primary_ops_state: "OK",
    created_at: nowIso, updated_at: nowIso, last_synced_at: nowIso, source_present_ghost: true,
    source_missing_since: "", last_seen_ghost_run_id: "run_current", source_record_hash: "hash",
  };
}

function signal(objectType: BillingSignalRow["object_type"], subscriptionId: string): BillingSignalRow {
  return {
    signal_key: `stripe:${objectType}:object_1`, object_type: objectType, stripe_object_id: "object_1",
    stripe_event_id: "", stripe_subscription_id: subscriptionId, stripe_customer_id: "cus_1",
    invoice_id: objectType === "invoice" ? "object_1" : "in_1", refund_id: objectType === "refund" ? "object_1" : "",
    dispute_id: objectType === "dispute" ? "object_1" : "", raw_status: "open",
    signal_kind: objectType === "invoice" ? "open_invoice" : objectType === "refund" ? "partial_refund" : "open_dispute",
    amount_minor: 1000, currency: "jpy", occurred_at: nowIso, next_payment_attempt_at: "", needs_action: true,
    resolved_at: "", last_seen_run_id: "run_previous", last_synced_at: nowIso,
  };
}
