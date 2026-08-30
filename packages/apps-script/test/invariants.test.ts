import { describe, expect, it } from "vitest";
import { accessGrantKey, memberRowKey, subscriptionRowKey } from "../src/domain/keys";
import { createLease, isLeaseActive, isLeaseHolder } from "../src/domain/lease";
import { markAndSweep } from "../src/domain/mark-sweep";
import { deriveThreeAxisState } from "../src/domain/state";
import { normalizeEmail, redactSecrets } from "../src/domain/values";
import type { SubscriptionRow } from "../src/domain/types";
import stripeFixture from "./fixtures/stripe-subscriptions.json";
import { mapStripeSubscription } from "../src/domain/stripe-mapper";
import type { StripeList, StripeSubscriptionRaw } from "../src/domain/types";

const nowIso = "2026-08-28T00:00:00.000Z";
const stripe = stripeFixture as unknown as StripeList<StripeSubscriptionRaw>;

describe("identity and data invariants", () => {
  it("uses immutable composite keys and only trim/lowercase email normalization", () => {
    expect(memberRowKey("site", "member")).toBe("ghost:site:member");
    expect(subscriptionRowKey("acct", true, "sub_1")).toBe("stripe:acct:true:sub_1");
    expect(accessGrantKey("site", "member", "tier", "gift")).toBe("ghost:site:member:tier:gift");
    expect(normalizeEmail(" First.Last+tag@Gmail.com ")).toBe("first.last+tag@gmail.com");
  });

  it("does not tombstone after a partial run, and tombstones without deleting after a complete scan", () => {
    const rows = [{ key: "a", last_seen: "old", present: true, missing_since: "", note: "manual" }];
    const partial = markAndSweep({
      records: rows,
      keyColumn: "key",
      lastSeenColumn: "last_seen",
      sourcePresentColumn: "present",
      sourceMissingSinceColumn: "missing_since",
      completedFullScan: false,
      runId: "new",
      nowIso,
    });
    expect(partial.records).toEqual(rows);
    const complete = markAndSweep({
      records: rows,
      keyColumn: "key",
      lastSeenColumn: "last_seen",
      sourcePresentColumn: "present",
      sourceMissingSinceColumn: "missing_since",
      completedFullScan: true,
      runId: "new",
      nowIso,
    });
    expect(complete.tombstoned).toBe(1);
    expect(complete.records[0]).toMatchObject({ key: "a", present: false, missing_since: nowIso, note: "manual" });
  });

  it("retains historical Ghost projection identity while leaving never-projected Stripe rows distinct", () => {
    const historical = {
      ...subscription("sub_historical", "active"),
      last_seen_ghost_run_id: "run_previous",
    };
    const neverProjected = {
      ...subscription("sub_stripe_only", "active"),
      ghost_member_id: "",
      minhos_member_id: "",
      source_present_ghost: false,
      last_seen_ghost_run_id: "",
    };
    const complete = markAndSweep({
      records: [historical, neverProjected],
      keyColumn: "subscription_row_key",
      lastSeenColumn: "last_seen_ghost_run_id",
      sourcePresentColumn: "source_present_ghost",
      sourceMissingSinceColumn: "source_missing_since",
      completedFullScan: true,
      runId: "run_current",
      nowIso,
    });

    expect(complete.tombstoned).toBe(1);
    expect(complete.records[0]).toMatchObject({
      source_present_ghost: false,
      source_missing_since: nowIso,
      ghost_member_id: "gm",
      minhos_member_id: "mm",
      last_seen_ghost_run_id: "run_previous",
    });
    expect(complete.records[1]).toMatchObject({
      source_present_ghost: false,
      source_missing_since: "",
      ghost_member_id: "",
      minhos_member_id: "",
      last_seen_ghost_run_id: "",
    });
  });

  it("keeps Ghost access, Stripe billing, and operations as three independent axes", () => {
    const mapped = mapStripeSubscription(stripe.data[1]!, {
      expectedAccountId: "acct",
      expectedLivemode: false,
      allowedPriceIds: new Set(["price_main_monthly"]),
      allowedProductIds: new Set(["stripe_product_main"]),
    }, { runId: "run", nowIso });
    expect(mapped.accepted).toBe(true);
    if (!mapped.accepted) return;
    const state = deriveThreeAxisState({
      ghostAccess: "paid",
      subscriptions: [mapped.row],
      grants: [],
      now: new Date(nowIso),
    });
    expect(state.ghostAccess).toBe("paid");
    expect(state.stripeBilling).toEqual(["past_due"]);
    expect(state.opsFlags).toContain("PAYMENT_ATTENTION");
    expect(state.opsFlags).toContain("OPEN_INVOICE");
  });

  it("does not revoke aggregate entitlement because one subscription is canceled", () => {
    const active = subscription("sub_active", "active");
    const canceled = subscription("sub_canceled", "canceled");
    const state = deriveThreeAxisState({
      ghostAccess: "paid",
      subscriptions: [canceled, active],
      grants: [],
      now: new Date(nowIso),
    });
    expect(state.qualifyingEntitlementCount).toBe(1);
  });

  it("treats run lease as active only until its expiry", () => {
    const lease = createLease("run", 1000, 5000);
    expect(isLeaseActive(lease, 5999)).toBe(true);
    expect(isLeaseActive(lease, 6000)).toBe(false);
    const fenced = createLease("run", 1000, 5000, "owner_new");
    expect(isLeaseHolder(fenced, "run", "owner_new")).toBe(true);
    expect(isLeaseHolder(fenced, "run", "owner_old")).toBe(false);
  });

  it("redacts credential-shaped values from logs", () => {
    const stripeKey = ["rk", "test", "examplecredential123456"].join("_");
    const ghostKey = `${"a".repeat(24)}:${"b".repeat(64)}`;
    const redacted = redactSecrets(`Authorization Bearer token.payload.signature ${stripeKey} ${ghostKey}`);
    expect(redacted).not.toContain(stripeKey);
    expect(redacted).not.toContain(ghostKey);
    expect(redacted).toContain("[REDACTED_STRIPE_KEY]");
    expect(redacted).toContain("[REDACTED_GHOST_KEY]");
  });
});

function subscription(id: string, status: SubscriptionRow["stripe_status"]): SubscriptionRow {
  return {
    subscription_row_key: `stripe:acct:false:${id}`, environment: "test", livemode: false, stripe_account_id: "acct",
    stripe_subscription_id: id, stripe_customer_id: "cus", ghost_member_id: "gm", minhos_member_id: "mm",
    stripe_product_id: "prod", stripe_price_id: "price", ghost_price_id: "", ghost_tier_id: "", tier_name: "",
    unit_amount_minor: 0, currency: "jpy", billing_interval: "month", stripe_status: status,
    ghost_projected_status: "", status_match: "", collection_method: "charge_automatically",
    pause_collection_behavior: "", cancel_at_period_end: false, start_date: "", current_period_start: "",
    current_period_end: "", canceled_at: "", ended_at: "", latest_invoice_id: "", latest_invoice_status: "",
    open_invoice_count: 0, last_invoice_paid_at: "", last_payment_failure_at: "", source_present_stripe: true,
    source_present_ghost: true, source_missing_since: "", last_seen_stripe_run_id: "run", last_seen_ghost_run_id: "run",
    last_synced_at: nowIso,
  };
}
