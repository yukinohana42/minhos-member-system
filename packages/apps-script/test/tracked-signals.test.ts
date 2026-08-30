import { describe, expect, it } from "vitest";
import { exceptionKey } from "../src/domain/keys";
import { planTrackedSignalPage } from "../src/domain/tracked-signals";
import type { BillingSignalRow, ExceptionRow } from "../src/domain/types";

describe("tracked refund/dispute pagination", () => {
  it("sorts stably, resumes from N+1, and terminates across a runtime boundary", () => {
    const signals = Array.from({ length: 23 }, (_, index) => signal(`refund_${String(22 - index).padStart(2, "0")}`));
    const seen: string[] = [];
    let afterKey: string | undefined;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = planTrackedSignalPage({ signals, exceptions: [], ...(afterKey ? { afterKey } : {}), limit: 10 });
      seen.push(...page.rows.map((row) => row.signal_key));
      const last = page.rows[page.rows.length - 1];
      afterKey = last?.signal_key;
      if (!page.hasMore) break;
    }
    expect(seen).toEqual([...signals].sort((a, b) => a.signal_key.localeCompare(b.signal_key)).map((row) => row.signal_key));
    expect(new Set(seen).size).toBe(23);
  });

  it("does not re-retrieve operator-ignored or resolved actionable signals", () => {
    const ignored = signal("refund_ignored");
    const resolved = signal("refund_resolved");
    const active = signal("refund_active");
    const exceptions = [
      exception(exceptionKey("REFUND_REVIEW_REQUIRED", ignored.refund_id), "ignored"),
      exception(exceptionKey("REFUND_REVIEW_REQUIRED", resolved.refund_id), "resolved"),
    ];
    expect(planTrackedSignalPage({ signals: [ignored, resolved, active], exceptions, limit: 10 }).rows)
      .toEqual([active]);
  });
});

function signal(id: string): BillingSignalRow {
  return {
    signal_key: `stripe:refund:${id}`, object_type: "refund", stripe_object_id: id, stripe_event_id: "",
    stripe_subscription_id: "sub_1", stripe_customer_id: "cus_1", invoice_id: "in_1", refund_id: id,
    dispute_id: "", raw_status: "succeeded", signal_kind: "full_or_unknown_refund", amount_minor: 100,
    currency: "jpy", occurred_at: "", next_payment_attempt_at: "", needs_action: true, resolved_at: "",
    last_seen_run_id: "run", last_synced_at: "2026-08-28T00:00:00.000Z",
  };
}

function exception(key: string, status: "ignored" | "resolved"): ExceptionRow {
  return {
    exception_key: key, exception_id: `ex_${status}`, severity: "P2", exception_type: "REFUND_REVIEW_REQUIRED",
    minhos_member_id: "", ghost_member_id: "", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1",
    first_detected_at: "", last_detected_at: "", occurrence_count: 1, last_notified_at: "", suppressed_until: "",
    summary: "", status, assignee: "", resolution: "", resolved_at: "", related_sync_run_id: "run",
  };
}
