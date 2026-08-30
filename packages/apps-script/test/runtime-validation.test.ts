import { describe, expect, it } from "vitest";
import { mapDisputeSignal, mapInvoiceSignal, mapRefundSignal } from "../src/domain/billing-signals";
import { mapGhostMember } from "../src/domain/ghost-mapper";
import { validateGhostMembersPage } from "../src/domain/ghost-runtime-validation";
import { mapStripeSubscription } from "../src/domain/stripe-mapper";
import { validateStripeRuntimeResponse } from "../src/domain/stripe-runtime-validation";
import { isoFromUnix } from "../src/domain/values";
import type {
  GhostMemberRaw,
  StripeDisputeRaw,
  StripeInvoiceRaw,
  StripeRefundRaw,
  StripeSubscriptionRaw,
} from "../src/domain/types";

const INVALID_DATE_VALUES: unknown[] = ["not-an-iso-date", "1700000000", 1.5, NaN, Infinity, {}, []];
const INVALID_TYPED_VALUES: unknown[] = ["5500", 1.5, NaN, Infinity, {}, []];
const INVALID_CURRENCY_VALUES: unknown[] = [1, false, {}, [], ""];
const INVALID_INTERVAL_VALUES: unknown[] = [1, false, {}, [], ""];

describe("strict shared date conversion", () => {
  it("keeps intentional blanks and Unix zero while rejecting invalid direct fixture values", () => {
    expect(isoFromUnix(undefined, "fixture.created")).toBe("");
    expect(isoFromUnix(null, "fixture.created")).toBe("");
    expect(isoFromUnix("", "fixture.created")).toBe("");
    expect(isoFromUnix(0, "fixture.created")).toBe("1970-01-01T00:00:00.000Z");
    expect(isoFromUnix("2026-08-28T00:00:00.000Z", "fixture.created")).toBe("2026-08-28T00:00:00.000Z");

    for (const value of [...INVALID_DATE_VALUES, -1, Number.MAX_SAFE_INTEGER]) {
      expect(() => isoFromUnix(value, "fixture.created")).toThrow("SCHEMA_MISMATCH:fixture.created");
    }
  });
});

describe("Ghost runtime date and optional-value validation", () => {
  it("accepts omitted/null/blank dates and typed Unix zero", () => {
    const page = ghostPage();
    validateGhostMembersPage(page);

    const datePaths = [
      ["members.0.created_at", ["members", 0, "created_at"]],
      ["members.0.updated_at", ["members", 0, "updated_at"]],
      ["members.0.subscriptions.0.start_date", ["members", 0, "subscriptions", 0, "start_date"]],
      ["members.0.subscriptions.0.current_period_start", ["members", 0, "subscriptions", 0, "current_period_start"]],
      ["members.0.subscriptions.0.current_period_end", ["members", 0, "subscriptions", 0, "current_period_end"]],
    ] as const;

    for (const [, path] of datePaths) {
      const nullable = ghostPage();
      setPath(nullable, path, null);
      validateGhostMembersPage(nullable);

      const blank = ghostPage();
      setPath(blank, path, "");
      validateGhostMembersPage(blank);

      const omitted = ghostPage();
      deletePath(omitted, path);
      validateGhostMembersPage(omitted);
    }

    const zero = ghostPage();
    setPath(zero, ["members", 0, "created_at"], 0);
    setPath(zero, ["members", 0, "subscriptions", 0, "current_period_end"], 0);
    validateGhostMembersPage(zero);
  });

  it("rejects every invalid Ghost ISO/Unix date with its nested path", () => {
    const paths = [
      [["members", 0, "created_at"], "SCHEMA_MISMATCH:ghost_members.members.0.created_at"],
      [["members", 0, "updated_at"], "SCHEMA_MISMATCH:ghost_members.members.0.updated_at"],
      [["members", 0, "subscriptions", 0, "start_date"], "SCHEMA_MISMATCH:ghost_members.members.0.subscriptions.0.start_date"],
      [["members", 0, "subscriptions", 0, "current_period_start"], "SCHEMA_MISMATCH:ghost_members.members.0.subscriptions.0.current_period_start"],
      [["members", 0, "subscriptions", 0, "current_period_end"], "SCHEMA_MISMATCH:ghost_members.members.0.subscriptions.0.current_period_end"],
    ] as const;

    for (const [path, error] of paths) {
      for (const value of INVALID_DATE_VALUES) {
        const page = ghostPage();
        setPath(page, path, value);
        expect(() => validateGhostMembersPage(page)).toThrow(error);
      }
    }
  });

  it("validates Ghost price amount and currency when present", () => {
    for (const value of INVALID_TYPED_VALUES) {
      const page = ghostPage();
      setPath(page, ["members", 0, "subscriptions", 0, "price", "amount"], value);
      expect(() => validateGhostMembersPage(page)).toThrow(
        "SCHEMA_MISMATCH:ghost_members.members.0.subscriptions.0.price.amount",
      );
    }
    for (const value of INVALID_CURRENCY_VALUES) {
      const page = ghostPage();
      setPath(page, ["members", 0, "subscriptions", 0, "price", "currency"], value);
      expect(() => validateGhostMembersPage(page)).toThrow(
        "SCHEMA_MISMATCH:ghost_members.members.0.subscriptions.0.price.currency",
      );
    }
  });

  it("does not treat Unix zero as omitted in direct Ghost mapping", () => {
    const raw = ghostPage().members[0] as unknown as GhostMemberRaw;
    raw.created_at = 0 as unknown as string;
    raw.updated_at = 0 as unknown as string;
    const mapped = mapGhostMember(raw, {
      ghostSiteId: "site_main",
      minhosMemberId: "mm_1",
      profileStatus: "not_submitted",
      runId: "run_1",
      nowIso: "2026-08-28T00:00:00.000Z",
    });
    expect(mapped.member.created_at).toBe("1970-01-01T00:00:00.000Z");
    expect(mapped.member.updated_at).toBe("1970-01-01T00:00:00.000Z");

    raw.created_at = "invalid";
    expect(() => mapGhostMember(raw, {
      ghostSiteId: "site_main",
      minhosMemberId: "mm_1",
      profileStatus: "not_submitted",
      runId: "run_1",
      nowIso: "2026-08-28T00:00:00.000Z",
    })).toThrow("SCHEMA_MISMATCH:ghost_members.members.0.created_at");
  });
});

describe("Stripe runtime date and optional-value validation", () => {
  it("accepts omitted/null optional fields and zero timestamps/amounts", () => {
    validateStripeRuntimeResponse("stripe_subscription", stripeSubscription());
    validateStripeRuntimeResponse("stripe_price", stripePrice());
    validateStripeRuntimeResponse("stripe_refund", stripeRefund());
    validateStripeRuntimeResponse("stripe_dispute", stripeDispute());

    const omitted = stripeSubscription();
    for (const path of [
      ["start_date"], ["current_period_start"], ["current_period_end"], ["canceled_at"], ["ended_at"],
      ["items", "data", 0, "current_period_start"], ["items", "data", 0, "current_period_end"],
      ["latest_invoice", "currency"], ["latest_invoice", "created"],
      ["latest_invoice", "next_payment_attempt"], ["latest_invoice", "status_transitions", "paid_at"],
    ] as const) {
      setPath(omitted, path, null);
    }
    setPath(omitted, ["latest_invoice", "status_transitions"], null);
    setPath(omitted, ["items", "data", 0, "price", "unit_amount"], null);
    setPath(omitted, ["items", "data", 0, "price", "currency"], null);
    setPath(omitted, ["items", "data", 0, "price", "recurring"], null);
    validateStripeRuntimeResponse("stripe_subscription", omitted);

    const noLatestInvoice = stripeSubscription();
    deletePath(noLatestInvoice, ["latest_invoice"]);
    validateStripeRuntimeResponse("stripe_subscription", noLatestInvoice);
  });

  it("rejects invalid subscription and item-period timestamps with exact paths", () => {
    const paths = [
      [["start_date"], "SCHEMA_MISMATCH:stripe_subscription.start_date"],
      [["current_period_start"], "SCHEMA_MISMATCH:stripe_subscription.current_period_start"],
      [["current_period_end"], "SCHEMA_MISMATCH:stripe_subscription.current_period_end"],
      [["canceled_at"], "SCHEMA_MISMATCH:stripe_subscription.canceled_at"],
      [["ended_at"], "SCHEMA_MISMATCH:stripe_subscription.ended_at"],
      [["items", "data", 0, "current_period_start"], "SCHEMA_MISMATCH:stripe_subscription.items.data.0.current_period_start"],
      [["items", "data", 0, "current_period_end"], "SCHEMA_MISMATCH:stripe_subscription.items.data.0.current_period_end"],
    ] as const;

    for (const [path, error] of paths) {
      for (const value of INVALID_DATE_VALUES) {
        const subscription = stripeSubscription();
        setPath(subscription, path, value);
        expect(() => validateStripeRuntimeResponse("stripe_subscription", subscription)).toThrow(error);
      }
    }
  });

  it("rejects invalid latest Invoice dates/currency and status-transition shape", () => {
    const datePaths = [
      [["latest_invoice", "created"], "SCHEMA_MISMATCH:stripe_subscription.latest_invoice.created"],
      [["latest_invoice", "next_payment_attempt"], "SCHEMA_MISMATCH:stripe_subscription.latest_invoice.next_payment_attempt"],
      [["latest_invoice", "status_transitions", "paid_at"], "SCHEMA_MISMATCH:stripe_subscription.latest_invoice.status_transitions.paid_at"],
    ] as const;
    for (const [path, error] of datePaths) {
      for (const value of INVALID_DATE_VALUES) {
        const subscription = stripeSubscription();
        setPath(subscription, path, value);
        expect(() => validateStripeRuntimeResponse("stripe_subscription", subscription)).toThrow(error);
      }
    }
    for (const value of INVALID_CURRENCY_VALUES) {
      const subscription = stripeSubscription();
      setPath(subscription, ["latest_invoice", "currency"], value);
      expect(() => validateStripeRuntimeResponse("stripe_subscription", subscription)).toThrow(
        "SCHEMA_MISMATCH:stripe_subscription.latest_invoice.currency",
      );
    }
    for (const value of ["not-an-object", 1, false, []]) {
      const subscription = stripeSubscription();
      setPath(subscription, ["latest_invoice", "status_transitions"], value);
      expect(() => validateStripeRuntimeResponse("stripe_subscription", subscription)).toThrow(
        "SCHEMA_MISMATCH:stripe_subscription.latest_invoice.status_transitions",
      );
    }
  });

  it("recursively validates expanded Invoice objects through PaymentIntent and Charge", () => {
    const throughPaymentIntent = stripeSubscription();
    setPath(throughPaymentIntent, ["latest_invoice", "payment_intent", "invoice"], invoice({ created: "bad-date" }));
    expect(() => validateStripeRuntimeResponse("stripe_subscription", throughPaymentIntent)).toThrow(
      "SCHEMA_MISMATCH:stripe_subscription.latest_invoice.payment_intent.invoice.created",
    );

    const throughCharge = stripeRefund();
    setPath(throughCharge, ["charge"], charge({ invoice: invoice({ currency: 42 }) }));
    expect(() => validateStripeRuntimeResponse("stripe_refund", throughCharge)).toThrow(
      "SCHEMA_MISMATCH:stripe_refund.charge.invoice.currency",
    );

    const throughRefundPaymentIntent = stripeRefund();
    setPath(throughRefundPaymentIntent, ["payment_intent"], paymentIntent({ invoice: invoice({ created: Infinity }) }));
    expect(() => validateStripeRuntimeResponse("stripe_refund", throughRefundPaymentIntent)).toThrow(
      "SCHEMA_MISMATCH:stripe_refund.payment_intent.invoice.created",
    );
  });

  it("validates Refund/Dispute created and top-level Price fields", () => {
    for (const [shape, makeValue, error] of [
      ["stripe_refund", stripeRefund, "SCHEMA_MISMATCH:stripe_refund.created"],
      ["stripe_dispute", stripeDispute, "SCHEMA_MISMATCH:stripe_dispute.created"],
    ] as const) {
      for (const value of INVALID_DATE_VALUES) {
        const item = makeValue();
        setPath(item, ["created"], value);
        expect(() => validateStripeRuntimeResponse(shape, item)).toThrow(error);
      }
    }

    for (const value of INVALID_TYPED_VALUES) {
      const price = stripePrice();
      setPath(price, ["unit_amount"], value);
      expect(() => validateStripeRuntimeResponse("stripe_price", price)).toThrow("SCHEMA_MISMATCH:stripe_price.unit_amount");
    }
    for (const value of INVALID_CURRENCY_VALUES) {
      const price = stripePrice();
      setPath(price, ["currency"], value);
      expect(() => validateStripeRuntimeResponse("stripe_price", price)).toThrow("SCHEMA_MISMATCH:stripe_price.currency");
    }
    for (const value of [1, false, "bad", []]) {
      const price = stripePrice();
      setPath(price, ["recurring"], value);
      expect(() => validateStripeRuntimeResponse("stripe_price", price)).toThrow("SCHEMA_MISMATCH:stripe_price.recurring");
    }
    for (const value of INVALID_INTERVAL_VALUES) {
      const price = stripePrice();
      setPath(price, ["recurring", "interval"], value);
      expect(() => validateStripeRuntimeResponse("stripe_price", price)).toThrow(
        "SCHEMA_MISMATCH:stripe_price.recurring.interval",
      );
    }
  });

  it("rejects unsafe monetary integers and whitespace-bearing stable identifiers", () => {
    for (const [shape, makeValue] of [
      ["stripe_refund", stripeRefund],
      ["stripe_dispute", stripeDispute],
    ] as const) {
      const item = makeValue();
      setPath(item, ["amount"], Number.MAX_SAFE_INTEGER + 1);
      expect(() => validateStripeRuntimeResponse(shape, item)).toThrow(`SCHEMA_MISMATCH:${shape}.amount`);
    }

    for (const [path, error] of [
      [["id"], "SCHEMA_MISMATCH:stripe_subscription.id"],
      [["customer"], "SCHEMA_MISMATCH:stripe_subscription.customer.id"],
      [["items", "data", 0, "price", "id"], "SCHEMA_MISMATCH:stripe_subscription.items.data.0.price.id"],
      [["items", "data", 0, "price", "product"], "SCHEMA_MISMATCH:stripe_subscription.items.data.0.price.product.id"],
      [["latest_invoice", "subscription"], "SCHEMA_MISMATCH:stripe_subscription.latest_invoice.subscription.id"],
    ] as const) {
      const subscription = stripeSubscription();
      setPath(subscription, path, " padded_id ");
      expect(() => validateStripeRuntimeResponse("stripe_subscription", subscription)).toThrow(error);
    }
  });

  it("does not blank invalid direct mapper dates and preserves Unix zero", () => {
    const raw = stripeSubscription() as unknown as StripeSubscriptionRaw;
    const mapped = mapStripeSubscription(raw, {
      expectedAccountId: "acct_expected",
      expectedLivemode: false,
      allowedPriceIds: new Set(["price_1"]),
      allowedProductIds: new Set(["prod_1"]),
    }, { runId: "run_1", nowIso: "2026-08-28T00:00:00.000Z" });
    expect(mapped.accepted).toBe(true);
    if (mapped.accepted) {
      expect(mapped.row.start_date).toBe("1970-01-01T00:00:00.000Z");
      expect(mapped.row.current_period_start).toBe("1970-01-01T00:00:00.000Z");
      expect(mapped.row.last_invoice_paid_at).toBe("1970-01-01T00:00:00.000Z");
    }

    raw.start_date = NaN;
    expect(() => mapStripeSubscription(raw, {
      expectedAccountId: "acct_expected",
      expectedLivemode: false,
      allowedPriceIds: new Set(["price_1"]),
      allowedProductIds: new Set(["prod_1"]),
    }, { runId: "run_1", nowIso: "2026-08-28T00:00:00.000Z" })).toThrow(
      "SCHEMA_MISMATCH:stripe_subscription.start_date",
    );
  });

  it("uses path-aware date conversion for billing signal mappers", () => {
    const context = { runId: "run_1", nowIso: "2026-08-28T00:00:00.000Z" };
    expect(() => mapInvoiceSignal(invoice({ created: "bad-date" }) as unknown as StripeInvoiceRaw, context)).toThrow(
      "SCHEMA_MISMATCH:stripe_invoice.created",
    );
    expect(() => mapRefundSignal({ ...stripeRefund(), created: Infinity } as unknown as StripeRefundRaw, {}, context)).toThrow(
      "SCHEMA_MISMATCH:stripe_refund.created",
    );
    expect(() => mapDisputeSignal({ ...stripeDispute(), created: 1.5 } as unknown as StripeDisputeRaw, {}, context)).toThrow(
      "SCHEMA_MISMATCH:stripe_dispute.created",
    );
  });
});

function ghostPage(): { members: Array<Record<string, unknown>> } {
  return {
    members: [{
      id: "member_1",
      email: "member@example.invalid",
      status: "paid",
      comped: false,
      created_at: "2026-08-28T00:00:00.000Z",
      updated_at: 0,
      tiers: [],
      subscriptions: [{
        id: "sub_1",
        customer: { id: "cus_1", name: null, email: null },
        status: "active",
        start_date: 0,
        current_period_start: null,
        current_period_end: 0,
        cancel_at_period_end: false,
        price: { id: "price_1", amount: 0, currency: "jpy", tier: { id: "prod_1" } },
        tier: { id: "tier_1" },
      }],
    }],
  };
}

function stripeSubscription(): Record<string, unknown> {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    livemode: false,
    start_date: 0,
    current_period_start: 0,
    current_period_end: 0,
    canceled_at: 0,
    ended_at: 0,
    cancel_at_period_end: false,
    pause_collection: null,
    items: {
      data: [{
        current_period_start: 0,
        current_period_end: 0,
        price: stripePrice(),
      }],
    },
    latest_invoice: invoice({
      status: "paid",
      currency: "jpy",
      created: 0,
      next_payment_attempt: 0,
      status_transitions: { paid_at: 0 },
      payment_intent: paymentIntent({ invoice: "in_1" }),
    }),
  };
}

function stripePrice(): Record<string, unknown> {
  return { id: "price_1", product: "prod_1", unit_amount: 0, currency: "jpy", recurring: { interval: "month" } };
}

function invoice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "in_1",
    status: "paid",
    customer: "cus_1",
    subscription: "sub_1",
    amount_due: 0,
    amount_paid: 0,
    currency: "jpy",
    created: 0,
    next_payment_attempt: null,
    status_transitions: { paid_at: 0 },
    ...overrides,
  };
}

function paymentIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "pi_1", customer: "cus_1", invoice: "in_1", ...overrides };
}

function charge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "ch_1", amount: 0, amount_refunded: 0, customer: "cus_1", ...overrides };
}

function stripeRefund(): Record<string, unknown> {
  return { id: "re_1", amount: 0, currency: "jpy", status: "succeeded", created: 0, charge: null, payment_intent: null };
}

function stripeDispute(): Record<string, unknown> {
  return { id: "dp_1", amount: 0, currency: "jpy", status: "won", created: 0, charge: null, payment_intent: null };
}

function setPath(root: Record<string, unknown>, path: readonly (string | number)[], value: unknown): void {
  let cursor: unknown = root;
  for (const segment of path.slice(0, -1)) {
    if (typeof segment === "number") {
      cursor = (cursor as unknown[])[segment];
    } else {
      cursor = (cursor as Record<string, unknown>)[segment];
    }
  }
  const last = path[path.length - 1]!;
  if (typeof last === "number") {
    (cursor as unknown[])[last] = value;
  } else {
    (cursor as Record<string, unknown>)[last] = value;
  }
}

function deletePath(root: Record<string, unknown>, path: readonly (string | number)[]): void {
  let cursor: unknown = root;
  for (const segment of path.slice(0, -1)) {
    cursor = typeof segment === "number"
      ? (cursor as unknown[])[segment]
      : (cursor as Record<string, unknown>)[segment];
  }
  const last = path[path.length - 1]!;
  if (typeof last === "number") {
    delete (cursor as unknown[])[last];
  } else {
    delete (cursor as Record<string, unknown>)[last];
  }
}
