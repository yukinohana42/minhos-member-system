import { subscriptionRowKey } from "./keys";
import { validateStripeRuntimeResponse } from "./stripe-runtime-validation";
import type { StripePriceRaw, StripeSubscriptionRaw, SubscriptionRow } from "./types";
import { asStripeStatus, idOf, isoFromUnix } from "./values";

export interface StripeScope {
  expectedAccountId: string;
  expectedLivemode: boolean;
  allowedPriceIds: ReadonlySet<string>;
  allowedProductIds: ReadonlySet<string>;
}

export type StripeSubscriptionMapping =
  | { accepted: true; row: SubscriptionRow }
  | { accepted: false; reason: "ENVIRONMENT_MISMATCH" | "MULTI_ITEM_UNSUPPORTED" | "PRICE_OUTSIDE_ALLOWLIST" | "PRODUCT_OUTSIDE_ALLOWLIST" };

export function validateStripeAccount(actualAccountId: string, expectedAccountId: string): void {
  if (!expectedAccountId || actualAccountId !== expectedAccountId) {
    throw new Error(`STRIPE_ACCOUNT_MISMATCH:${actualAccountId || "missing"}`);
  }
}

export function mapStripeSubscription(
  raw: StripeSubscriptionRaw,
  scope: StripeScope,
  context: { runId: string; nowIso: string },
): StripeSubscriptionMapping {
  validateStripeRuntimeResponse("stripe_subscription", raw);
  if (raw.livemode !== scope.expectedLivemode) return { accepted: false, reason: "ENVIRONMENT_MISMATCH" };

  const prices = raw.items.data.map(({ price }) => price);
  if (prices.length !== 1) return { accepted: false, reason: "MULTI_ITEM_UNSUPPORTED" };
  if (prices.some((candidate) => !scope.allowedPriceIds.has(candidate.id))) {
    return { accepted: false, reason: "PRICE_OUTSIDE_ALLOWLIST" };
  }
  const productIds = prices.map(productIdOf);
  if (productIds.some((productId) => !productId || !scope.allowedProductIds.has(productId))) {
    return { accepted: false, reason: "PRODUCT_OUTSIDE_ALLOWLIST" };
  }
  const price = prices[0]!;
  const productId = productIds[0]!;

  const latestInvoice = typeof raw.latest_invoice === "object" && raw.latest_invoice ? raw.latest_invoice : null;
  const firstItem = raw.items.data[0];
  const currentPeriodStart = raw.current_period_start !== undefined && raw.current_period_start !== null
    ? isoFromUnix(raw.current_period_start, "stripe_subscription.current_period_start")
    : isoFromUnix(firstItem?.current_period_start, "stripe_subscription.items.data.0.current_period_start");
  const currentPeriodEnd = raw.current_period_end !== undefined && raw.current_period_end !== null
    ? isoFromUnix(raw.current_period_end, "stripe_subscription.current_period_end")
    : isoFromUnix(firstItem?.current_period_end, "stripe_subscription.items.data.0.current_period_end");

  return {
    accepted: true,
    row: {
      subscription_row_key: subscriptionRowKey(scope.expectedAccountId, raw.livemode, raw.id),
      environment: raw.livemode ? "live" : "test",
      livemode: raw.livemode,
      stripe_account_id: scope.expectedAccountId,
      stripe_subscription_id: raw.id,
      stripe_customer_id: idOf(raw.customer),
      ghost_member_id: "",
      minhos_member_id: "",
      stripe_product_id: productId,
      stripe_price_id: price.id,
      ghost_price_id: "",
      ghost_tier_id: "",
      tier_name: "",
      unit_amount_minor: price.unit_amount ?? 0,
      currency: price.currency ?? "",
      billing_interval: price.recurring?.interval ?? "",
      stripe_status: asStripeStatus(raw.status),
      ghost_projected_status: "",
      status_match: "unmatched",
      collection_method: raw.collection_method ?? "",
      pause_collection_behavior: raw.pause_collection?.behavior ?? "",
      cancel_at_period_end: raw.cancel_at_period_end ?? false,
      start_date: isoFromUnix(raw.start_date, "stripe_subscription.start_date"),
      current_period_start: currentPeriodStart,
      current_period_end: currentPeriodEnd,
      canceled_at: isoFromUnix(raw.canceled_at, "stripe_subscription.canceled_at"),
      ended_at: isoFromUnix(raw.ended_at, "stripe_subscription.ended_at"),
      latest_invoice_id: typeof raw.latest_invoice === "string" ? raw.latest_invoice : latestInvoice?.id ?? "",
      latest_invoice_status: latestInvoice?.status ?? "",
      open_invoice_count: latestInvoice?.status === "open" ? 1 : 0,
      last_invoice_paid_at: isoFromUnix(
        latestInvoice?.status_transitions?.paid_at,
        "stripe_subscription.latest_invoice.status_transitions.paid_at",
      ),
      // Stripe does not guarantee a timestamp on PaymentIntent.last_payment_error.
      // Keep this unknown rather than inventing a failure time.
      last_payment_failure_at: "",
      source_present_stripe: true,
      source_present_ghost: false,
      source_missing_since: "",
      last_seen_stripe_run_id: context.runId,
      last_seen_ghost_run_id: "",
      last_synced_at: context.nowIso,
    },
  };
}

function productIdOf(price: StripePriceRaw): string {
  return typeof price.product === "string" ? price.product : price.product?.id ?? "";
}

export function mergeGhostProjection(
  stripe: SubscriptionRow,
  projection: {
    ghost_member_id: string;
    minhos_member_id: string;
    ghost_projected_status: string;
    ghost_price_id: string;
    ghost_tier_id: string;
    tier_name: string;
    source_present_ghost: boolean;
    last_seen_ghost_run_id: string;
  } | undefined,
): SubscriptionRow {
  if (!projection) return { ...stripe, source_present_ghost: false, status_match: "missing_ghost_projection" };
  return {
    ...stripe,
    ghost_member_id: projection.ghost_member_id,
    minhos_member_id: projection.minhos_member_id,
    ghost_projected_status: projection.ghost_projected_status,
    ghost_price_id: projection.ghost_price_id,
    ghost_tier_id: projection.ghost_tier_id,
    tier_name: projection.tier_name,
    source_present_ghost: projection.source_present_ghost,
    // source_missing_since is shared by the Stripe and Ghost presence axes.
    // A Ghost reappearance closes the clock only when Stripe is also present.
    source_missing_since:
      projection.source_present_ghost && stripe.source_present_stripe
        ? ""
        : stripe.source_missing_since,
    last_seen_ghost_run_id: projection.last_seen_ghost_run_id,
    status_match:
      projection.ghost_projected_status === stripe.stripe_status ? "match" : "mismatch",
  };
}

/**
 * Preserve the shared absence clock across a Stripe refresh while Ghost is
 * still absent. A refreshed Stripe row may clear it only when both sources are
 * present; a never-projected Stripe-only row has no absence clock to inherit.
 */
export function mergeStripeRefreshSourcePresence(
  refreshed: SubscriptionRow,
  previous: SubscriptionRow | undefined,
): SubscriptionRow {
  return {
    ...refreshed,
    source_missing_since:
      previous && !previous.source_present_ghost
        ? previous.source_missing_since
        : "",
  };
}
