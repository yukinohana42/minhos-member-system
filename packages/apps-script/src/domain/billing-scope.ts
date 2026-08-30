import { exceptionKey } from "./keys";
import type { BillingSignalRow, ExceptionFinding, SubscriptionRow } from "./types";

export interface BillingScope {
  runId: string;
  expectedAccountId: string;
  expectedLivemode: boolean;
  allowedPriceIds: ReadonlySet<string>;
  allowedProductIds: ReadonlySet<string>;
}

export function billingSignalScopeViolation(
  signal: BillingSignalRow,
  subscriptions: SubscriptionRow[],
  scope: BillingScope,
): string | null {
  if (!signal.stripe_subscription_id) return "SUBSCRIPTION_UNRESOLVED";
  const subscription = subscriptions.find(
    (candidate) =>
      candidate.stripe_subscription_id === signal.stripe_subscription_id &&
      candidate.source_present_stripe &&
      candidate.last_seen_stripe_run_id === scope.runId,
  );
  if (!subscription) return "SUBSCRIPTION_OUTSIDE_CURRENT_SCAN";
  if (
    subscription.stripe_account_id !== scope.expectedAccountId ||
    subscription.livemode !== scope.expectedLivemode
  ) {
    return "ENVIRONMENT_MISMATCH";
  }
  if (!scope.allowedPriceIds.has(subscription.stripe_price_id)) return "PRICE_OUTSIDE_ALLOWLIST";
  if (!scope.allowedProductIds.has(subscription.stripe_product_id)) return "PRODUCT_OUTSIDE_ALLOWLIST";
  return null;
}

export function assertBillingSignalsInScope(
  signals: BillingSignalRow[],
  subscriptions: SubscriptionRow[],
  scope: BillingScope,
): void {
  for (const signal of signals) {
    const violation = billingSignalScopeViolation(signal, subscriptions, scope);
    if (violation) {
      // Deliberately omit external identifiers from logs/notifications.
      throw new Error(`STRIPE_SCOPE_VIOLATION:${signal.object_type}:${violation}`);
    }
  }
}

/**
 * Convert a rejected signal into a durable quarantine finding. The caller
 * persists this in 50_Exceptions and never writes the raw out-of-scope object
 * into the main billing ledger.
 */
export function billingScopeExceptionFinding(
  signal: BillingSignalRow,
  violation: string,
): { finding: ExceptionFinding; unmatched: boolean } {
  const unmatched = violation === "SUBSCRIPTION_UNRESOLVED" &&
    (signal.object_type === "refund" || signal.object_type === "dispute");
  return {
    unmatched,
    finding: {
      exceptionKey: exceptionKey(
        unmatched ? "UNMATCHED_BILLING_SIGNAL" : "BILLING_SCOPE_VIOLATION",
        signal.object_type,
        signal.stripe_object_id,
      ),
      exceptionType: unmatched ? "UNMATCHED_BILLING_SIGNAL" : "BILLING_SCOPE_VIOLATION",
      severity: signal.object_type === "dispute" || !unmatched ? "P1" : "P2",
      summary: unmatched
        ? `${signal.object_type} (${signal.raw_status}) を対象Subscriptionへ照合できないため隔離しました。`
        : `${signal.object_type}が同期対象scope外を参照したため隔離しました。`,
      stripeCustomerId: unmatched ? signal.stripe_customer_id : "",
      immediate: signal.object_type === "dispute" || !unmatched,
    },
  };
}
