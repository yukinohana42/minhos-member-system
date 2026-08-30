import { describe, expect, it } from "vitest";
import { findOperationalExceptions, reconcileExceptionRows } from "../src/domain/exceptions";
import { markNotificationsSent, notificationDeliveryBatch, planExceptionNotifications } from "../src/domain/notifications";
import type { BillingSignalRow, ExceptionFinding, ExceptionRow, SubscriptionRow } from "../src/domain/types";

const nowIso = "2026-08-28T00:00:00.000Z";

describe("exception upsert and notification suppression", () => {
  it("detects P1/P2 states, missing Ghost member, duplicate subscription, and open dispute", () => {
    const subscriptions = [subscription("sub_1", "unpaid"), subscription("sub_2", "active")];
    const findings = findOperationalExceptions({
      members: [],
      subscriptions,
      grants: [],
      signals: [disputeSignal()],
      now: new Date(nowIso),
    });
    expect(findings.map((item) => item.exceptionType)).toEqual(expect.arrayContaining([
      "PAYMENT_UNPAID", "MISSING_GHOST_MEMBER", "DUPLICATE_SUBSCRIPTION", "OPEN_DISPUTE",
    ]));
    expect(findings.find((item) => item.exceptionType === "PAYMENT_UNPAID")?.severity).toBe("P1");
  });

  it("upserts one exception key, preserves manual fields, resolves it, and reopens on recurrence", () => {
    const finding = mismatchFinding();
    const first = reconcileExceptionRows({ existing: [], findings: [finding], runId: "run_1", nowIso, newId: () => "ex_1" });
    expect(first).toHaveLength(1);
    const acknowledged: ExceptionRow = { ...first[0]!, status: "acknowledged", assignee: "運営", resolution: "確認中" };
    const second = reconcileExceptionRows({ existing: [acknowledged], findings: [finding], runId: "run_2", nowIso: "2026-08-28T01:00:00.000Z", newId: () => "never" });
    expect(second[0]).toMatchObject({ exception_id: "ex_1", occurrence_count: 2, assignee: "運営", resolution: "確認中", status: "acknowledged" });
    const resolved = reconcileExceptionRows({ existing: second, findings: [], runId: "run_3", nowIso: "2026-08-28T02:00:00.000Z", newId: () => "never" });
    expect(resolved[0]?.status).toBe("resolved");
    const reopened = reconcileExceptionRows({ existing: resolved, findings: [finding], runId: "run_4", nowIso: "2026-08-28T03:00:00.000Z", newId: () => "never" });
    expect(reopened[0]).toMatchObject({ exception_id: "ex_1", occurrence_count: 3, status: "open", resolution: "" });
  });

  it("counts item replay and final reconcile only once within the same run", () => {
    const finding = mismatchFinding();
    const first = reconcileExceptionRows({
      existing: [], findings: [finding], runId: "run_same", nowIso,
      newId: () => "ex_same",
    });
    const replay = reconcileExceptionRows({
      existing: first, findings: [finding], runId: "run_same",
      nowIso: "2026-08-28T00:10:00.000Z", newId: () => "never",
    });
    expect(replay[0]).toMatchObject({
      exception_id: "ex_same",
      occurrence_count: 1,
      last_detected_at: nowIso,
      related_sync_run_id: "run_same",
    });

    const laterRun = reconcileExceptionRows({
      existing: replay, findings: [finding], runId: "run_later",
      nowIso: "2026-08-29T00:00:00.000Z", newId: () => "never",
    });
    expect(laterRun[0]).toMatchObject({
      occurrence_count: 2,
      last_detected_at: "2026-08-29T00:00:00.000Z",
      related_sync_run_id: "run_later",
    });
  });

  it("delays non-emergency mismatch until the second occurrence and avoids hourly resend", () => {
    const finding = mismatchFinding();
    const first = reconcileExceptionRows({ existing: [], findings: [finding], runId: "run_1", nowIso, newId: () => "ex_1" });
    expect(planExceptionNotifications({ before: [], after: first, findings: [finding], now: new Date(nowIso) })).toEqual([]);
    const second = reconcileExceptionRows({ existing: first, findings: [finding], runId: "run_2", nowIso: "2026-08-28T01:00:00.000Z", newId: () => "never" });
    const initialNotice = planExceptionNotifications({ before: first, after: second, findings: [finding], now: new Date("2026-08-28T01:00:00.000Z") });
    expect(initialNotice).toHaveLength(1);
    const notified = { ...second[0]!, last_notified_at: "2026-08-28T01:00:00.000Z" };
    const third = reconcileExceptionRows({ existing: [notified], findings: [finding], runId: "run_3", nowIso: "2026-08-28T02:00:00.000Z", newId: () => "never" });
    expect(planExceptionNotifications({ before: [notified], after: third, findings: [finding], now: new Date("2026-08-28T02:00:00.000Z") })).toEqual([]);
  });

  it("notifies emergency findings immediately and sends one recovery", () => {
    const finding: ExceptionFinding = { ...mismatchFinding(), exceptionType: "OPEN_DISPUTE", exceptionKey: "OPEN_DISPUTE:dp_1", immediate: true };
    const opened = reconcileExceptionRows({ existing: [], findings: [finding], runId: "run_1", nowIso, newId: () => "ex_1" });
    expect(planExceptionNotifications({ before: [], after: opened, findings: [finding], now: new Date(nowIso) })[0]?.kind).toBe("opened");
    const notified = { ...opened[0]!, last_notified_at: nowIso };
    const resolved = reconcileExceptionRows({ existing: [notified], findings: [], runId: "run_2", nowIso: "2026-08-28T01:00:00.000Z", newId: () => "never" });
    expect(planExceptionNotifications({ before: [notified], after: resolved, findings: [], now: new Date("2026-08-28T01:00:00.000Z") })[0]?.kind).toBe("recovered");
  });

  it("marks only the 50 decisions actually included in one notification", () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({
      ...reconcileExceptionRows({
        existing: [],
        findings: [{
          exceptionKey: `OPEN_DISPUTE:dp_${index}`, exceptionType: "OPEN_DISPUTE", severity: "P1" as const,
          summary: `dispute ${index}`, immediate: true,
        }],
        runId: "run", nowIso, newId: () => `ex_${index}`,
      })[0]!,
    }));
    const decisions = rows.map((row) => ({
      exceptionKey: row.exception_key, kind: "opened" as const, severity: row.severity, summary: row.summary,
    }));
    const delivered = notificationDeliveryBatch(decisions);
    const marked = markNotificationsSent(rows, delivered, nowIso);
    expect(delivered).toHaveLength(50);
    expect(marked.filter((row) => row.last_notified_at === nowIso)).toHaveLength(50);
    expect(marked[50]?.last_notified_at).toBe("");
  });
});

function mismatchFinding(): ExceptionFinding {
  return {
    exceptionKey: "GHOST_ACCESS_WITHOUT_BILLING:gm_1",
    exceptionType: "GHOST_ACCESS_WITHOUT_BILLING",
    severity: "P1",
    summary: "一時的な標準連携遅延の可能性があります。",
    ghostMemberId: "gm_1",
  };
}

function subscription(id: string, status: SubscriptionRow["stripe_status"]): SubscriptionRow {
  return {
    subscription_row_key: `stripe:acct:false:${id}`, environment: "test", livemode: false, stripe_account_id: "acct",
    stripe_subscription_id: id, stripe_customer_id: "cus_1", ghost_member_id: "gm_missing", minhos_member_id: "mm_1",
    stripe_product_id: "prod", stripe_price_id: "price", ghost_price_id: "", ghost_tier_id: "", tier_name: "",
    unit_amount_minor: 5500, currency: "jpy", billing_interval: "month", stripe_status: status,
    ghost_projected_status: "", status_match: "missing_ghost_projection", collection_method: "charge_automatically",
    pause_collection_behavior: "", cancel_at_period_end: false, start_date: "", current_period_start: "",
    current_period_end: "", canceled_at: "", ended_at: "", latest_invoice_id: "", latest_invoice_status: "",
    open_invoice_count: 0, last_invoice_paid_at: "", last_payment_failure_at: "", source_present_stripe: true,
    source_present_ghost: false, source_missing_since: "", last_seen_stripe_run_id: "run", last_seen_ghost_run_id: "",
    last_synced_at: nowIso,
  };
}

function disputeSignal(): BillingSignalRow {
  return {
    signal_key: "stripe:dispute:dp_1", object_type: "dispute", stripe_object_id: "dp_1", stripe_event_id: "",
    stripe_subscription_id: "sub_1", stripe_customer_id: "cus_1", invoice_id: "in_1", refund_id: "", dispute_id: "dp_1",
    raw_status: "needs_response", signal_kind: "open_dispute", amount_minor: 5500, currency: "jpy", occurred_at: nowIso,
    next_payment_attempt_at: "", needs_action: true, resolved_at: "", last_seen_run_id: "run", last_synced_at: nowIso,
  };
}
