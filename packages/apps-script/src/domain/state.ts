import type {
  AccessGrantRow,
  GhostAccessState,
  StripeBillingState,
  SubscriptionRow,
  ThreeAxisState,
} from "./types";

const QUALIFYING_STRIPE = new Set<StripeBillingState>(["active", "trialing", "past_due", "unpaid"]);

const OPS_PRIORITY: ReadonlyArray<string> = [
  "OPEN_DISPUTE",
  "MISSING_GHOST_MEMBER",
  "PAYMENT_UNPAID",
  "PAYMENT_PAUSED",
  "PAUSE_COLLECTION",
  "DUPLICATE_SUBSCRIPTION",
  "TRIAL_NOT_ALLOWED",
  "PAYMENT_ATTENTION",
  "OPEN_INVOICE",
  "CANCEL_AT_PERIOD_END",
  "PROFILE_REVIEW_REQUIRED",
  "PROFILE_NOT_SUBMITTED",
];

export function isStripeEntitlement(status: StripeBillingState): boolean {
  return QUALIFYING_STRIPE.has(status);
}

export function isNonTerminalSubscription(status: StripeBillingState): boolean {
  return !new Set<StripeBillingState>(["canceled", "incomplete_expired"]).has(status);
}

export function isGrantActive(grant: Pick<AccessGrantRow, "starts_at" | "expires_at">, now: Date): boolean {
  const starts = grant.starts_at ? Date.parse(grant.starts_at) : Number.NEGATIVE_INFINITY;
  const expires = grant.expires_at ? Date.parse(grant.expires_at) : Number.POSITIVE_INFINITY;
  return starts <= now.getTime() && now.getTime() < expires;
}

export function primaryOpsState(flags: string[]): string {
  const unique = [...new Set(flags)];
  return OPS_PRIORITY.find((candidate) => unique.includes(candidate)) ?? unique.sort()[0] ?? "OK";
}

export function deriveThreeAxisState(input: {
  ghostAccess: GhostAccessState;
  subscriptions: SubscriptionRow[];
  grants: AccessGrantRow[];
  externalFlags?: string[];
  now: Date;
}): ThreeAxisState {
  const statuses = input.subscriptions.map(({ stripe_status }) => stripe_status);
  const activeSubscriptions = statuses.filter(isStripeEntitlement).length;
  const activeGrants = input.grants.filter((grant) => isGrantActive(grant, input.now)).length;
  const flags = [...(input.externalFlags ?? [])];

  for (const subscription of input.subscriptions) {
    if (subscription.stripe_status === "past_due") flags.push("PAYMENT_ATTENTION");
    if (subscription.stripe_status === "unpaid") flags.push("PAYMENT_UNPAID");
    if (subscription.stripe_status === "paused") flags.push("PAYMENT_PAUSED");
    if (subscription.stripe_status === "trialing") flags.push("TRIAL_NOT_ALLOWED");
    if (subscription.pause_collection_behavior) flags.push("PAUSE_COLLECTION");
    if (subscription.latest_invoice_status === "open" || subscription.open_invoice_count > 0) flags.push("OPEN_INVOICE");
    if (subscription.cancel_at_period_end) flags.push("CANCEL_AT_PERIOD_END");
  }

  if (input.subscriptions.filter(({ stripe_status }) => isNonTerminalSubscription(stripe_status)).length > 1) {
    flags.push("DUPLICATE_SUBSCRIPTION");
  }

  const uniqueFlags = [...new Set(flags)].sort();
  return {
    ghostAccess: input.ghostAccess,
    stripeBilling: statuses,
    opsFlags: uniqueFlags,
    primaryOpsState: primaryOpsState(uniqueFlags),
    qualifyingEntitlementCount: activeSubscriptions + activeGrants,
  };
}
