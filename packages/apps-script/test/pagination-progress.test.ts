import { describe, expect, it } from "vitest";
import { nextGhostPage } from "../src/domain/ghost-pagination";
import { nextStripePageCursor, validateStripePage } from "../src/domain/stripe-pagination";

describe("pagination progress fences", () => {
  it.each(["subscriptions", "open_invoices", "refunds", "disputes"] as const)(
    "rejects a replayed %s Stripe page before persisting the same cursor",
    (endpoint) => {
      expect(() => nextStripePageCursor({
        endpoint,
        hasMore: true,
        currentCursor: "object_same",
        lastId: "object_same",
      })).toThrow(`PAGINATION_NO_PROGRESS:stripe_${endpoint}`);
    },
  );

  it("returns an advancing Stripe cursor and clears it at the terminal page", () => {
    expect(nextStripePageCursor({
      endpoint: "subscriptions", hasMore: true, currentCursor: "sub_1", lastId: "sub_2",
    })).toBe("sub_2");
    expect(nextStripePageCursor({ endpoint: "subscriptions", hasMore: false, currentCursor: "sub_2" }))
      .toBeNull();
  });

  it("rejects a Ghost next page that repeats or moves behind the requested page", () => {
    expect(() => nextGhostPage({
      members: [], meta: { pagination: { page: 2, pages: 3, next: 2 } },
    }, 2)).toThrow("PAGINATION_NO_PROGRESS:ghost_members");
    expect(() => nextGhostPage({
      members: [], meta: { pagination: { page: 2, pages: 3, next: 1 } },
    }, 2)).toThrow("PAGINATION_NO_PROGRESS:ghost_members");
  });

  it("validates a Stripe page before item mutation", () => {
    expect(() => validateStripePage({
      endpoint: "refunds", items: [], hasMore: true,
    })).toThrow("SCHEMA_MISMATCH:stripe_refunds.missing_last_id");
    expect(() => validateStripePage({
      endpoint: "disputes", items: [{ id: "dp_1" }, { id: "dp_1" }], hasMore: false,
    })).toThrow("PAGINATION_DUPLICATE_ITEM:stripe_disputes");
    expect(() => validateStripePage({
      endpoint: "refunds", items: [{ id: "re_1" }, { id: "re_2" }], hasMore: true, requestCursor: "re_1",
    })).toThrow("PAGINATION_NO_PROGRESS:stripe_refunds");
  });
});
