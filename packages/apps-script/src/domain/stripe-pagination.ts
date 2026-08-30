export type StripeListEndpoint = "subscriptions" | "open_invoices" | "refunds" | "disputes";

/**
 * Validate a page before any item mutation. List APIs should never return an
 * empty `has_more` page, duplicate object IDs, or the request cursor itself;
 * accepting any of those shapes can cause an endless resume loop or silently
 * skip a billing signal.
 */
export function validateStripePage(input: {
  endpoint: StripeListEndpoint;
  items: ReadonlyArray<{ id: string }>;
  hasMore: boolean;
  requestCursor?: string;
}): void {
  if (input.items.some((item) => !item.id)) {
    throw new Error(`SCHEMA_MISMATCH:stripe_${input.endpoint}.missing_item_id`);
  }
  if (new Set(input.items.map((item) => item.id)).size !== input.items.length) {
    throw new Error(`PAGINATION_DUPLICATE_ITEM:stripe_${input.endpoint}`);
  }
  if (input.requestCursor && input.items.some((item) => item.id === input.requestCursor)) {
    throw new Error(`PAGINATION_NO_PROGRESS:stripe_${input.endpoint}`);
  }
  // nextStripePageCursor also checks that a has_more page has a last ID and
  // that the page-level cursor advances. It is intentionally called before
  // the caller maps or writes any item.
  nextStripePageCursor({
    endpoint: input.endpoint,
    hasMore: input.hasMore,
    ...(input.requestCursor ? { currentCursor: input.requestCursor } : {}),
    ...(input.items.length ? { lastId: input.items[input.items.length - 1]!.id } : {}),
  });
}

/**
 * A Stripe list cursor must advance whenever has_more is true. Reusing the
 * request cursor would otherwise persist an endless resume loop.
 */
export function nextStripePageCursor(input: {
  endpoint: StripeListEndpoint;
  hasMore: boolean;
  currentCursor?: string;
  lastId?: string;
}): string | null {
  if (!input.hasMore) return null;
  if (!input.lastId) throw new Error(`SCHEMA_MISMATCH:stripe_${input.endpoint}.missing_last_id`);
  if (input.currentCursor && input.lastId === input.currentCursor) {
    throw new Error(`PAGINATION_NO_PROGRESS:stripe_${input.endpoint}`);
  }
  return input.lastId;
}
