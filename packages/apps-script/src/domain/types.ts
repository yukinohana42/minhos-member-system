export type RunType = "hourly" | "nightly" | "manual" | "resume";
export type Severity = "P1" | "P2" | "P3";
export type ExceptionStatus = "open" | "acknowledged" | "resolved" | "ignored";
export type GhostAccessState = "paid" | "free" | "unknown";
export type GhostGrantKind = "comped" | "gift";
export type ProfileStatus = "not_submitted" | "review_required" | "matched";
export type StripeBillingState =
  | "active"
  | "trialing"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "paused"
  | "unknown";

export type CellValue = string | number | boolean | null;
export type SheetRecord = Record<string, CellValue>;

export interface GhostTierRaw {
  id?: string | null;
  tier_id?: string | null;
  name?: string | null;
  type?: string | null;
  active?: boolean | null;
}

export interface GhostPriceRaw {
  id?: string | null;
  price_id?: string | null;
  nickname?: string | null;
  amount?: number | null;
  interval?: string | null;
  type?: string | null;
  currency?: string | null;
  tier?: GhostTierRaw | null;
}

export interface GhostSubscriptionRaw {
  id?: string | null;
  customer?: string | { id?: string | null; name?: string | null; email?: string | null } | null;
  status?: string | null;
  start_date?: string | number | null;
  cancel_at_period_end?: boolean | null;
  current_period_start?: string | number | null;
  current_period_end?: string | number | null;
  price?: GhostPriceRaw | null;
  tier?: GhostTierRaw | null;
  type?: string | null;
  gift?: boolean | null;
}

export interface GhostMemberRaw {
  id: string;
  uuid?: string | null;
  email?: string | null;
  name?: string | null;
  status?: string | null;
  comped?: boolean | null;
  tiers?: GhostTierRaw[] | null;
  subscriptions?: GhostSubscriptionRaw[] | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface GhostMembersPage {
  members: GhostMemberRaw[];
  meta?: {
    pagination?: {
      page?: number;
      pages?: number;
      next?: number | null;
    };
  };
}

export interface StripeList<T> {
  object: "list";
  data: T[];
  has_more: boolean;
  url?: string;
}

export interface StripeProductRaw {
  id: string;
  active?: boolean;
  name?: string | null;
}

export interface StripePriceRaw {
  id: string;
  active?: boolean;
  currency?: string | null;
  unit_amount?: number | null;
  recurring?: { interval?: string | null } | null;
  product?: string | StripeProductRaw | null;
}

export interface StripeInvoiceRaw {
  id: string;
  status?: string | null;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
  parent?: {
    type?: string | null;
    subscription_details?: { subscription?: string | { id: string } | null } | null;
  } | null;
  amount_due?: number | null;
  amount_paid?: number | null;
  currency?: string | null;
  created?: number | null;
  next_payment_attempt?: number | null;
  status_transitions?: { paid_at?: number | null } | null;
  payment_intent?: string | StripePaymentIntentRaw | null;
  livemode?: boolean;
}

export interface StripeSubscriptionRaw {
  id: string;
  customer: string | { id: string; email?: string | null };
  status: string;
  livemode: boolean;
  collection_method?: string | null;
  pause_collection?: { behavior?: string | null } | null;
  cancel_at_period_end?: boolean;
  start_date?: number | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
  canceled_at?: number | null;
  ended_at?: number | null;
  latest_invoice?: string | StripeInvoiceRaw | null;
  items: {
    data: Array<{
      price: StripePriceRaw;
      current_period_start?: number | null;
      current_period_end?: number | null;
    }>;
  };
}

export interface StripeChargeRaw {
  id: string;
  amount?: number | null;
  amount_refunded?: number | null;
  customer?: string | { id: string } | null;
  invoice?: string | StripeInvoiceRaw | null;
  payment_intent?: string | StripePaymentIntentRaw | null;
}

export interface StripePaymentIntentRaw {
  id: string;
  customer?: string | { id: string } | null;
  invoice?: string | StripeInvoiceRaw | null;
  last_payment_error?: Record<string, unknown> | null;
}

export interface StripeRefundRaw {
  id: string;
  amount: number;
  currency: string;
  status?: string | null;
  created?: number | null;
  charge?: string | StripeChargeRaw | null;
  payment_intent?: string | StripePaymentIntentRaw | null;
}

export interface StripeDisputeRaw {
  id: string;
  amount: number;
  currency: string;
  status?: string | null;
  created?: number | null;
  charge?: string | StripeChargeRaw | null;
  payment_intent?: string | StripePaymentIntentRaw | null;
}

export interface MemberRow extends SheetRecord {
  minhos_member_id: string;
  member_row_key: string;
  ghost_site_id: string;
  ghost_member_id: string;
  member_uuid: string;
  email: string;
  name: string;
  ghost_member_status: string;
  ghost_access_state: GhostAccessState;
  tier_ids: string;
  stripe_customer_ids: string;
  stripe_customer_count: number;
  qualifying_entitlement_count: number;
  profile_status: ProfileStatus;
  ops_flags: string;
  primary_ops_state: string;
  created_at: string;
  updated_at: string;
  last_synced_at: string;
  source_present_ghost: boolean;
  source_missing_since: string;
  last_seen_ghost_run_id: string;
  source_record_hash: string;
}

export interface GhostSubscriptionProjection {
  stripe_subscription_id: string;
  stripe_customer_id: string;
  ghost_member_id: string;
  minhos_member_id: string;
  ghost_projected_status: string;
  ghost_price_id: string;
  stripe_price_id: string;
  stripe_product_id: string;
  ghost_tier_id: string;
  tier_name: string;
  source_present_ghost: boolean;
  last_seen_ghost_run_id: string;
}

export interface AccessGrantRow extends SheetRecord {
  grant_key: string;
  minhos_member_id: string;
  ghost_member_id: string;
  tier_id: string;
  grant_kind: GhostGrantKind;
  starts_at: string;
  expires_at: string;
  grant_reason: string;
  approved_by: string;
  source_present_ghost: boolean;
  source_missing_since: string;
  last_seen_ghost_run_id: string;
  last_synced_at: string;
}

export interface SubscriptionRow extends SheetRecord {
  subscription_row_key: string;
  environment: string;
  livemode: boolean;
  stripe_account_id: string;
  stripe_subscription_id: string;
  stripe_customer_id: string;
  ghost_member_id: string;
  minhos_member_id: string;
  stripe_product_id: string;
  stripe_price_id: string;
  ghost_price_id: string;
  ghost_tier_id: string;
  tier_name: string;
  unit_amount_minor: number;
  currency: string;
  billing_interval: string;
  stripe_status: StripeBillingState;
  ghost_projected_status: string;
  status_match: string;
  collection_method: string;
  pause_collection_behavior: string;
  cancel_at_period_end: boolean;
  start_date: string;
  current_period_start: string;
  current_period_end: string;
  canceled_at: string;
  ended_at: string;
  latest_invoice_id: string;
  latest_invoice_status: string;
  open_invoice_count: number;
  last_invoice_paid_at: string;
  last_payment_failure_at: string;
  source_present_stripe: boolean;
  source_present_ghost: boolean;
  source_missing_since: string;
  last_seen_stripe_run_id: string;
  last_seen_ghost_run_id: string;
  last_synced_at: string;
}

export interface BillingSignalRow extends SheetRecord {
  signal_key: string;
  object_type: "invoice" | "refund" | "dispute";
  stripe_object_id: string;
  stripe_event_id: string;
  stripe_subscription_id: string;
  stripe_customer_id: string;
  invoice_id: string;
  refund_id: string;
  dispute_id: string;
  raw_status: string;
  signal_kind: string;
  amount_minor: number;
  currency: string;
  occurred_at: string;
  next_payment_attempt_at: string;
  needs_action: boolean;
  resolved_at: string;
  last_seen_run_id: string;
  last_synced_at: string;
}

export interface ExceptionFinding {
  exceptionKey: string;
  severity: Severity;
  exceptionType: string;
  summary: string;
  minhosMemberId?: string;
  ghostMemberId?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  immediate?: boolean;
}

export interface ExceptionRow extends SheetRecord {
  exception_key: string;
  exception_id: string;
  severity: Severity;
  exception_type: string;
  minhos_member_id: string;
  ghost_member_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  first_detected_at: string;
  last_detected_at: string;
  occurrence_count: number;
  last_notified_at: string;
  suppressed_until: string;
  summary: string;
  status: ExceptionStatus;
  assignee: string;
  resolution: string;
  resolved_at: string;
  related_sync_run_id: string;
}

export interface ThreeAxisState {
  ghostAccess: GhostAccessState;
  stripeBilling: StripeBillingState[];
  opsFlags: string[];
  primaryOpsState: string;
  qualifyingEntitlementCount: number;
}

export interface SyncCursor {
  schemaVersion: number;
  contextFingerprint: string;
  runId: string;
  requestedRunType: Exclude<RunType, "resume">;
  phase: string;
  ghostPage?: number;
  stripeStartingAfter?: string;
  /**
   * Pinned created[gte] lower bound for the current Refund/Dispute phase.
   * `null` explicitly represents the first complete Dispute history scan,
   * where no lower bound is allowed.
   */
  stripeCreatedGte?: number | null;
  trackedSignalAfterKey?: string;
  /** Last unseen open Invoice signal whose retrieve/upsert committed. */
  reconcileInvoiceAfterKey?: string;
  /**
   * Durable two-step marker for a reconcile table replacement. `pending` is
   * written before the Sheet mutation; `committed` is written after it. A
   * resumed run can therefore replay an uncertain replace idempotently while
   * applying its tombstone delta exactly once.
   */
  reconcileTombstoneCommit?: {
    table: "members" | "subscriptions" | "grants";
    state: "pending" | "committed";
    baseTombstoned: number;
    deltaTombstoned: number;
  };
  startedAt: string;
  attempts?: Array<{ startedAt: string; entrypoint: RunType }>;
  stats?: {
    ghostPages: number;
    ghostRecords: number;
    stripePages: number;
    stripeRecords: number;
    billingPages: number;
    billingRecords: number;
    inserted?: number;
    updated?: number;
    unchanged?: number;
    tombstoned?: number;
  };
}

export interface RunLease {
  runId: string;
  ownerId?: string;
  expiresAtMs: number;
}
