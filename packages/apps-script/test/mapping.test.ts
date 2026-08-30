import { describe, expect, it } from "vitest";
import ghostFixture from "./fixtures/ghost-members.json";
import stripeFixture from "./fixtures/stripe-subscriptions.json";
import billingFixture from "./fixtures/stripe-billing-signals.json";
import { mapGhostMember } from "../src/domain/ghost-mapper";
import {
  mapStripeSubscription,
  mergeGhostProjection,
  mergeStripeRefreshSourcePresence,
} from "../src/domain/stripe-mapper";
import { mapDisputeSignal, mapRefundSignal } from "../src/domain/billing-signals";
import type {
  GhostMembersPage,
  StripeChargeRaw,
  StripeDisputeRaw,
  StripeInvoiceRaw,
  StripeList,
  StripePaymentIntentRaw,
  StripeRefundRaw,
  StripeSubscriptionRaw,
} from "../src/domain/types";

const nowIso = "2026-08-28T00:00:00.000Z";
const ghost = ghostFixture as unknown as GhostMembersPage;
const stripe = stripeFixture as unknown as StripeList<StripeSubscriptionRaw>;
const billing = billingFixture as unknown as {
  charges: StripeChargeRaw[];
  payment_intents: StripePaymentIntentRaw[];
  invoices: StripeInvoiceRaw[];
  refunds: StripeRefundRaw[];
  disputes: StripeDisputeRaw[];
};

describe("Ghost member mapping", () => {
  it("uses customer.id, normalizes email, and keeps Ghost/Stripe IDs separate", () => {
    const raw = ghost.members[0];
    expect(raw).toBeDefined();
    const result = mapGhostMember(raw!, {
      ghostSiteId: "site_main",
      minhosMemberId: "mm_1",
      profileStatus: "not_submitted",
      runId: "run_1",
      nowIso,
    });
    expect(result.member.email).toBe("paid.member@example.com");
    expect(result.member.member_row_key).toBe("ghost:site_main:ghost_member_paid");
    expect(result.member.stripe_customer_ids).toBe("cus_paid_1");
    expect(result.member.profile_status).toBe("not_submitted");
    expect(result.subscriptions[0]).toMatchObject({
      stripe_subscription_id: "sub_active_1",
      stripe_customer_id: "cus_paid_1",
      stripe_product_id: "stripe_product_main",
      stripe_price_id: "price_main_monthly",
      ghost_price_id: "ghost_price_monthly",
      ghost_tier_id: "ghost_tier_main",
    });
  });

  it("maps comped and gift synthetic subscriptions with blank ids to collision-free grants", () => {
    const comped = mapGhostMember(ghost.members[2]!, {
      ghostSiteId: "site_main",
      minhosMemberId: "mm_comped",
      profileStatus: "not_submitted",
      runId: "run_1",
      nowIso,
    });
    const gift = mapGhostMember(ghost.members[3]!, {
      ghostSiteId: "site_main",
      minhosMemberId: "mm_gift",
      profileStatus: "not_submitted",
      runId: "run_1",
      nowIso,
    });
    expect(comped.subscriptions).toHaveLength(0);
    expect(gift.subscriptions).toHaveLength(0);
    expect(comped.grants[0]?.grant_key).toBe("ghost:site_main:ghost_member_comped:ghost_tier_main:comped");
    expect(gift.grants[0]?.grant_key).toBe("ghost:site_main:ghost_member_gift:ghost_tier_main:gift");
    expect(comped.grants[0]?.grant_key).not.toBe(gift.grants[0]?.grant_key);
  });

  it("enumerates Ghost free/paid/comped/gift member statuses without inventing unknown access", () => {
    for (const status of ["paid", "comped", "gift"] as const) {
      const mapped = mapGhostMember({
        id: `member_${status}`, email: `${status}@example.invalid`, status, subscriptions: [], tiers: [],
      }, {
        ghostSiteId: "site_main", minhosMemberId: `mm_${status}`, profileStatus: "not_submitted", runId: "run_1", nowIso,
      });
      expect(mapped.member).toMatchObject({ ghost_member_status: status, ghost_access_state: "paid" });
    }
    const free = mapGhostMember({
      id: "member_free", email: "free@example.invalid", status: "free", subscriptions: [], tiers: [],
    }, {
      ghostSiteId: "site_main", minhosMemberId: "mm_free", profileStatus: "not_submitted", runId: "run_1", nowIso,
    });
    expect(free.member).toMatchObject({ ghost_member_status: "free", ghost_access_state: "free" });
  });

  it("uses a trim-stable tier_id alias when the Ghost tier id is intentionally blank", () => {
    const raw = structuredClone(ghost.members[0]!);
    raw.tiers = [{ id: "", tier_id: "ghost_tier_alias", name: "Alias tier" }];
    raw.subscriptions![0]!.tier = { id: "", tier_id: "ghost_tier_alias", name: "Alias tier" };
    const mapped = mapGhostMember(raw, {
      ghostSiteId: "site_main",
      minhosMemberId: "mm_alias",
      profileStatus: "not_submitted",
      runId: "run_1",
      nowIso,
    });

    expect(mapped.member.tier_ids).toBe("ghost_tier_alias");
    expect(mapped.subscriptions[0]?.ghost_tier_id).toBe("ghost_tier_alias");
  });
});

describe("Stripe subscription mapping", () => {
  const scope = {
    expectedAccountId: "acct_expected",
    expectedLivemode: false,
    allowedPriceIds: new Set(["price_main_monthly"]),
    allowedProductIds: new Set(["stripe_product_main"]),
  };

  it("maps status=all results, expanded latest invoice, and new item-level periods", () => {
    const result = mapStripeSubscription(stripe.data[0]!, scope, { runId: "run_1", nowIso });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.row.subscription_row_key).toBe("stripe:acct_expected:false:sub_active_1");
    expect(result.row.latest_invoice_id).toBe("in_paid_1");
    expect(result.row.latest_invoice_status).toBe("paid");
    expect(result.row.current_period_start).toBe("2026-08-28T00:00:00.000Z");
    expect(result.row.current_period_end).toBe("2026-09-28T00:00:00.000Z");
    expect(result.row.stripe_status).toBe("active");
    expect(result.row.last_payment_failure_at).toBe("");
  });

  it("rejects environment and Price allowlist violations", () => {
    const wrongEnvironment = { ...stripe.data[0]!, livemode: true };
    expect(mapStripeSubscription(wrongEnvironment, scope, { runId: "run_1", nowIso })).toEqual({
      accepted: false,
      reason: "ENVIRONMENT_MISMATCH",
    });
    const wrongPrice = structuredClone(stripe.data[0]!);
    wrongPrice.items.data[0]!.price.id = "price_outside";
    expect(mapStripeSubscription(wrongPrice, scope, { runId: "run_1", nowIso })).toEqual({
      accepted: false,
      reason: "PRICE_OUTSIDE_ALLOWLIST",
    });
  });

  it("rejects every multi-item subscription for the MVP, even when all items are allowlisted", () => {
    const mixedPrice = structuredClone(stripe.data[0]!);
    mixedPrice.items.data.push({
      price: { ...mixedPrice.items.data[0]!.price },
    });
    expect(mapStripeSubscription(mixedPrice, scope, { runId: "run_1", nowIso })).toEqual({
      accepted: false,
      reason: "MULTI_ITEM_UNSUPPORTED",
    });
  });

  it("merges Ghost projection without collapsing raw Stripe and Ghost statuses", () => {
    const mapped = mapStripeSubscription(stripe.data[1]!, scope, { runId: "run_1", nowIso });
    expect(mapped.accepted).toBe(true);
    if (!mapped.accepted) return;
    const merged = mergeGhostProjection({
      ...mapped.row,
      source_missing_since: "2026-08-27T00:00:00.000Z",
    }, {
      ghost_member_id: "ghost_due",
      minhos_member_id: "mm_due",
      ghost_projected_status: "active",
      ghost_price_id: "ghost_price_monthly",
      ghost_tier_id: "ghost_tier_main",
      tier_name: "みんほす会員",
      source_present_ghost: true,
      last_seen_ghost_run_id: "run_1",
    });
    expect(merged.stripe_status).toBe("past_due");
    expect(merged.ghost_projected_status).toBe("active");
    expect(merged.status_match).toBe("mismatch");
    expect(merged.source_missing_since).toBe("");
  });

  it("preserves the shared missing-since clock on Stripe refresh until Ghost is present", () => {
    const mapped = mapStripeSubscription(stripe.data[0]!, scope, { runId: "run_2", nowIso });
    expect(mapped.accepted).toBe(true);
    if (!mapped.accepted) return;
    const missingSince = "2026-08-27T00:00:00.000Z";
    const historicalGhostTombstone = {
      ...mapped.row,
      ghost_member_id: "ghost_historical",
      minhos_member_id: "mm_historical",
      source_present_ghost: false,
      source_missing_since: missingSince,
      last_seen_ghost_run_id: "run_previous",
    };
    expect(mergeStripeRefreshSourcePresence(mapped.row, historicalGhostTombstone).source_missing_since)
      .toBe(missingSince);
    expect(mergeStripeRefreshSourcePresence(mapped.row, {
      ...historicalGhostTombstone,
      source_present_ghost: true,
    }).source_missing_since).toBe("");
    expect(mergeStripeRefreshSourcePresence(mapped.row, undefined).source_missing_since).toBe("");
  });
});

describe("Refund and dispute transformation", () => {
  const lookups = {
    charges: new Map(billing.charges.map((item) => [item.id, item])),
    paymentIntents: new Map(billing.payment_intents.map((item) => [item.id, item])),
    invoices: new Map(billing.invoices.map((item) => [item.id, item])),
  };

  it("resolves Refund -> Charge -> Invoice -> new parent.subscription_details shape", () => {
    const signal = mapRefundSignal(billing.refunds[0]!, lookups, { runId: "run_1", nowIso });
    expect(signal).toMatchObject({
      signal_key: "stripe:refund:re_partial_pending",
      signal_kind: "partial_refund",
      stripe_subscription_id: "sub_active_1",
      stripe_customer_id: "cus_paid_1",
      invoice_id: "in_paid_1",
      raw_status: "pending",
      needs_action: true,
    });
  });

  it("distinguishes terminal failed refund and keeps an unmatched signal nullable", () => {
    const failed = mapRefundSignal(billing.refunds[1]!, lookups, { runId: "run_1", nowIso });
    const unmatched = mapRefundSignal(billing.refunds[2]!, lookups, { runId: "run_1", nowIso });
    expect(failed.signal_kind).toBe("full_or_unknown_refund");
    expect(failed.raw_status).toBe("failed");
    expect(failed.needs_action).toBe(false);
    expect(unmatched.stripe_subscription_id).toBe("");
    expect(unmatched.needs_action).toBe(true);
  });

  it("keeps a successful full refund actionable until operator review and terminal failures auditable", () => {
    const succeeded = mapRefundSignal({
      id: "re_full_succeeded", amount: 5500, currency: "jpy", status: "succeeded", charge: "ch_partial",
    }, lookups, { runId: "run_1", nowIso });
    const canceled = mapRefundSignal({
      id: "re_full_canceled", amount: 5500, currency: "jpy", status: "canceled", charge: "ch_partial",
    }, lookups, { runId: "run_1", nowIso });
    expect(succeeded).toMatchObject({
      signal_kind: "full_or_unknown_refund", raw_status: "succeeded", needs_action: true, resolved_at: "",
    });
    expect(canceled).toMatchObject({
      signal_kind: "full_or_unknown_refund", raw_status: "canceled", needs_action: false, resolved_at: nowIso,
    });
    expect(canceled.signal_key).toBe("stripe:refund:re_full_canceled");
  });

  it("treats multiple successful partial refunds that cumulatively reach Charge.amount as full", () => {
    const cumulativeLookups = {
      ...lookups,
      charges: new Map([["ch_cumulative", {
        id: "ch_cumulative", amount: 5500, amount_refunded: 5500,
        customer: "cus_paid_1", invoice: "in_paid_1",
      }]]),
      refundTotalsByCharge: new Map([["ch_cumulative", 5500]]),
    };
    const finalPartial = mapRefundSignal({
      id: "re_partial_2", amount: 3000, currency: "jpy", status: "succeeded", charge: "ch_cumulative",
    }, cumulativeLookups, { runId: "run_1", nowIso });
    expect(finalPartial).toMatchObject({ signal_kind: "full_or_unknown_refund", needs_action: true, resolved_at: "" });

    const authoritative = mapRefundSignal({
      id: "re_partial_authoritative", amount: 500, currency: "jpy", status: "succeeded", charge: "ch_partial",
    }, {
      ...lookups,
      charges: new Map([["ch_partial", { ...billing.charges[0]!, amount_refunded: 5500 }]]),
    }, { runId: "run_1", nowIso });
    expect(authoritative).toMatchObject({ signal_kind: "full_or_unknown_refund", needs_action: true });
  });

  it("keeps open disputes actionable and resolves a won dispute", () => {
    const open = mapDisputeSignal(billing.disputes[0]!, lookups, { runId: "run_1", nowIso });
    const won = mapDisputeSignal(billing.disputes[1]!, lookups, { runId: "run_1", nowIso });
    expect(open).toMatchObject({ stripe_subscription_id: "sub_past_due_1", needs_action: true, signal_kind: "open_dispute" });
    expect(won.needs_action).toBe(false);
    expect(won.resolved_at).toBe(nowIso);
  });
});
