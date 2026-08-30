import { accessGrantKey, memberRowKey } from "./keys";
import { validateGhostMembersPage } from "./ghost-runtime-validation";
import { isStripeEntitlement } from "./state";
import type {
  AccessGrantRow,
  GhostMemberRaw,
  GhostSubscriptionRaw,
  GhostSubscriptionProjection,
  GhostGrantKind,
  MemberRow,
} from "./types";
import { asStripeStatus, compactStrings, isoFromUnix, normalizeEmail, stableHash } from "./values";

export interface GhostMemberMapping {
  member: MemberRow;
  subscriptions: GhostSubscriptionProjection[];
  grants: AccessGrantRow[];
}

export function mapGhostMember(
  raw: GhostMemberRaw,
  context: {
    ghostSiteId: string;
    minhosMemberId: string;
    profileStatus: MemberRow["profile_status"];
    runId: string;
    nowIso: string;
  },
): GhostMemberMapping {
  validateGhostMembersPage({ members: [raw] });
  const subscriptions = raw.subscriptions ?? [];
  const tierIds = compactStrings([
    ...(raw.tiers ?? []).map((tier) => firstNonblank(tier.id, tier.tier_id)),
    ...subscriptions.map((subscription) =>
      firstNonblank(
        subscription.tier?.id,
        subscription.tier?.tier_id,
        subscription.price?.tier?.tier_id,
        subscription.price?.tier?.id,
      ),
    ),
  ]);
  const stripeCustomerIds = compactStrings(subscriptions.map((subscription) => ghostCustomerId(subscription.customer)));
  const ghostSubscriptions = subscriptions
    .filter((subscription) => Boolean(subscription.id) && !isGrantSubscription(subscription))
    .map((subscription): GhostSubscriptionProjection => {
      const price = subscription.price;
      return {
        stripe_subscription_id: subscription.id ?? "",
        stripe_customer_id: ghostCustomerId(subscription.customer),
        ghost_member_id: raw.id,
        minhos_member_id: context.minhosMemberId,
        ghost_projected_status: subscription.status ?? "",
        stripe_price_id: price?.id ?? "",
        ghost_price_id: price?.price_id ?? "",
        stripe_product_id: firstNonblank(price?.tier?.id, price?.tier?.tier_id),
        ghost_tier_id: firstNonblank(subscription.tier?.id, subscription.tier?.tier_id, price?.tier?.tier_id, price?.tier?.id),
        tier_name: firstNonblank(subscription.tier?.name, price?.tier?.name, price?.nickname),
        source_present_ghost: true,
        last_seen_ghost_run_id: context.runId,
      };
    });

  const grantsByKey = new Map<string, AccessGrantRow>();
  if (raw.comped) {
    for (const tierId of tierIds) {
      const grant = createGrant(raw, tierId, "comped", context);
      grantsByKey.set(grant.grant_key, grant);
    }
  }
  for (const [index, subscription] of subscriptions.entries()) {
    if (!isGrantSubscription(subscription)) continue;
    const grantKind = subscription.gift || subscription.type === "gift" ? "gift" : "comped";
    const tierId =
      firstNonblank(
        subscription.tier?.id,
        subscription.tier?.tier_id,
        subscription.price?.tier?.tier_id,
        subscription.price?.tier?.id,
      ) || "unassigned";
    const grant = createGrant(raw, tierId, grantKind, context, {
      startsAt: isoFromUnix(subscription.start_date, `ghost_member.subscriptions.${index}.start_date`),
      expiresAt: isoFromUnix(subscription.current_period_end, `ghost_member.subscriptions.${index}.current_period_end`),
    });
    grantsByKey.set(grant.grant_key, grant);
  }

  const hasPaidProjection = subscriptions.some((subscription) =>
    isStripeEntitlement(asStripeStatus(subscription.status)),
  );
  const ghostAccessState = ["paid", "comped", "gift"].includes(raw.status ?? "") || raw.comped || hasPaidProjection
    ? "paid"
    : raw.status === "free"
      ? "free"
      : "unknown";
  const createdAt = raw.created_at !== undefined && raw.created_at !== null && raw.created_at !== ""
    ? isoFromUnix(raw.created_at, "ghost_member.created_at")
    : context.nowIso;
  const updatedAt = raw.updated_at !== undefined && raw.updated_at !== null && raw.updated_at !== ""
    ? isoFromUnix(raw.updated_at, "ghost_member.updated_at")
    : context.nowIso;

  return {
    member: {
      member_row_key: memberRowKey(context.ghostSiteId, raw.id),
      minhos_member_id: context.minhosMemberId,
      ghost_site_id: context.ghostSiteId,
      ghost_member_id: raw.id,
      member_uuid: raw.uuid ?? "",
      email: normalizeEmail(raw.email),
      name: raw.name?.trim() ?? "",
      ghost_member_status: raw.status ?? "",
      ghost_access_state: ghostAccessState,
      tier_ids: tierIds.join(","),
      stripe_customer_ids: stripeCustomerIds.join(","),
      stripe_customer_count: stripeCustomerIds.length,
      qualifying_entitlement_count: 0,
      // Supplied by the Supplemental owner; never inferred from Ghost fields.
      profile_status: context.profileStatus,
      ops_flags: "",
      primary_ops_state: "OK",
      created_at: createdAt,
      updated_at: updatedAt,
      last_synced_at: context.nowIso,
      source_present_ghost: true,
      source_missing_since: "",
      last_seen_ghost_run_id: context.runId,
      source_record_hash: stableHash(raw),
    },
    subscriptions: ghostSubscriptions,
    grants: [...grantsByKey.values()],
  };
}

function firstNonblank(...values: Array<string | null | undefined>): string {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? "";
}

function isGrantSubscription(subscription: NonNullable<GhostMemberRaw["subscriptions"]>[number]): boolean {
  return (
    subscription.type === "comped" ||
    subscription.type === "complimentary" ||
    subscription.type === "gift" ||
    subscription.gift === true ||
    !subscription.id ||
    !ghostCustomerId(subscription.customer)
  );
}

function ghostCustomerId(customer: GhostSubscriptionRaw["customer"]): string {
  return typeof customer === "string" ? customer : customer?.id ?? "";
}

function createGrant(
  raw: GhostMemberRaw,
  tierId: string,
  grantKind: GhostGrantKind,
  context: { ghostSiteId: string; minhosMemberId: string; runId: string; nowIso: string },
  dates: { startsAt?: string; expiresAt?: string } = {},
): AccessGrantRow {
  return {
    grant_key: accessGrantKey(context.ghostSiteId, raw.id, tierId, grantKind),
    minhos_member_id: context.minhosMemberId,
    ghost_member_id: raw.id,
    tier_id: tierId,
    grant_kind: grantKind,
    starts_at: dates.startsAt ?? "",
    expires_at: dates.expiresAt ?? "",
    grant_reason: "",
    approved_by: "",
    source_present_ghost: true,
    source_missing_since: "",
    last_seen_ghost_run_id: context.runId,
    last_synced_at: context.nowIso,
  };
}
