export interface SheetDefinition {
  name: string;
  /** Canonical schema metadata; composite keys are written as expressions. */
  primaryKey: string;
  /** Physical column used by the repository for upsert. */
  keyColumn: string;
  columns: string[];
  requiredMetrics?: string[];
}

/**
 * Google Forms creates and evolves this tab's physical columns. It is kept
 * outside SHEET_DEFINITIONS so no repository path can mistake native headers
 * for a managed schema or synthesize a response-ID column which Forms does not
 * provide.
 */
export const PROFILE_RAW_SHEET_CONTRACT = {
  name: "30_Profile_RAW",
  schemaMode: "google-forms-native-opaque",
  owner: "google-form-only",
  writeMode: "never-edit",
  primaryKey: null,
  columns: [] as readonly string[],
  nativeContract: {
    headerPolicy: "google-forms-managed-variable",
    columnCountPolicy: "google-forms-managed-variable",
    scriptReadsCells: false,
    scriptWritesCells: false,
    responseIdColumn: false,
    responseIdSource: "FormResponse.getId()",
    responseIdTarget: "40_Supplemental.profile_response_id",
  },
} as const;

export const PROFILE_RAW_SHEET_NAME = PROFILE_RAW_SHEET_CONTRACT.name;

export const DASHBOARD_REQUIRED_METRICS = [
  "ghost_registered_members",
  "ghost_paid_access_members",
  "ghost_free_or_no_access_members",
  "stripe_nonterminal_subscriptions",
  "stripe_past_due_subscriptions",
  "stripe_unpaid_subscriptions",
  "stripe_paused_subscriptions",
  "stripe_pause_collection_subscriptions",
  "stripe_open_invoice_count",
  "cancel_at_period_end_subscriptions",
  "duplicate_subscription_members",
  "open_disputes",
  "profile_not_submitted",
  "profile_review_required",
  "open_p1_exceptions",
  "open_p2_exceptions",
  "last_regular_sync_success",
  "last_full_sync_success",
  "last_sync_result",
  "publisher_member_utilization_percent",
  "publisher_warning_800",
  "publisher_warning_900",
  "ghost_staff_count",
  "ghost_pending_invitation_count",
  "ghost_staff_and_pending_total",
];

export const SHEET_DEFINITIONS: SheetDefinition[] = [
  {
    name: "00_Dashboard",
    primaryKey: "metric",
    keyColumn: "metric",
    columns: ["metric", "value", "updated_at", "description"],
    requiredMetrics: DASHBOARD_REQUIRED_METRICS,
  },
  {
    name: "10_Members",
    primaryKey: "ghost_site_id + ghost_member_id",
    keyColumn: "member_row_key",
    columns: [
      "member_row_key", "minhos_member_id", "ghost_site_id", "ghost_member_id", "member_uuid", "email", "name",
      "ghost_member_status", "ghost_access_state", "tier_ids", "stripe_customer_ids", "stripe_customer_count",
      "qualifying_entitlement_count", "profile_status", "ops_flags", "primary_ops_state", "created_at", "updated_at",
      "last_synced_at", "source_present_ghost", "source_missing_since", "last_seen_ghost_run_id", "source_record_hash",
    ],
  },
  {
    name: "20_Subscriptions",
    primaryKey: "subscription_row_key",
    keyColumn: "subscription_row_key",
    columns: [
      "subscription_row_key", "environment", "livemode", "stripe_account_id", "stripe_subscription_id",
      "stripe_customer_id", "ghost_member_id", "minhos_member_id", "stripe_product_id", "stripe_price_id",
      "ghost_price_id", "ghost_tier_id", "tier_name", "unit_amount_minor", "currency", "billing_interval",
      "stripe_status", "ghost_projected_status", "status_match", "collection_method", "pause_collection_behavior",
      "cancel_at_period_end", "start_date", "current_period_start", "current_period_end", "canceled_at", "ended_at",
      "latest_invoice_id", "latest_invoice_status", "open_invoice_count", "last_invoice_paid_at",
      "last_payment_failure_at", "source_present_stripe", "source_present_ghost", "source_missing_since",
      "last_seen_stripe_run_id", "last_seen_ghost_run_id", "last_synced_at",
    ],
  },
  {
    name: "21_AccessGrants",
    primaryKey: "grant_key",
    keyColumn: "grant_key",
    columns: [
      "grant_key", "minhos_member_id", "ghost_member_id", "tier_id", "grant_kind", "starts_at", "expires_at",
      "grant_reason", "approved_by", "source_present_ghost", "source_missing_since", "last_seen_ghost_run_id", "last_synced_at",
    ],
  },
  {
    name: "25_BillingSignals",
    primaryKey: "signal_key",
    keyColumn: "signal_key",
    columns: [
      "signal_key", "object_type", "stripe_object_id", "stripe_event_id", "stripe_subscription_id",
      "stripe_customer_id", "invoice_id", "refund_id", "dispute_id", "raw_status", "signal_kind", "amount_minor",
      "currency", "occurred_at", "next_payment_attempt_at", "needs_action", "resolved_at", "last_seen_run_id", "last_synced_at",
    ],
  },
  {
    name: "40_Supplemental",
    primaryKey: "minhos_member_id",
    keyColumn: "minhos_member_id",
    columns: [
      "minhos_member_id", "ghost_member_id", "profile_response_id", "profile_email_at_submission", "match_basis",
      "verification_status", "form_affiliation", "form_title_or_role", "form_participant_type", "override_affiliation",
      "override_title_or_role", "override_participant_type", "effective_affiliation", "effective_title_or_role",
      "effective_participant_type", "profile_updated_at", "ops_owner", "ops_note",
    ],
  },
  {
    name: "50_Exceptions",
    primaryKey: "exception_key",
    keyColumn: "exception_key",
    columns: [
      "exception_key", "exception_id", "severity", "exception_type", "minhos_member_id", "ghost_member_id",
      "stripe_customer_id", "stripe_subscription_id", "first_detected_at", "last_detected_at", "occurrence_count",
      "last_notified_at", "suppressed_until", "summary", "status", "assignee", "resolution", "resolved_at",
      "related_sync_run_id",
    ],
  },
  {
    name: "60_ContentRegistry",
    primaryKey: "lecture_id",
    keyColumn: "lecture_id",
    columns: [
      "lecture_id", "ghost_post_id", "slug", "lecture_date", "site_first_published_at", "youtube_video_id",
      "youtube_playlist_id", "youtube_visibility", "youtube_visibility_checked_at", "dropbox_file_path",
      "dropbox_shared_link", "shared_link_expires_at", "pdf_version", "rights_checked_at", "rights_expires_at",
      "content_owner", "last_link_checked_at", "content_status",
    ],
  },
  {
    name: "80_OpsLog",
    primaryKey: "ops_log_id",
    keyColumn: "ops_log_id",
    columns: ["ops_log_id", "operation_type", "operator", "occurred_at", "reason", "before", "after", "external_ids", "related_exception", "approver"],
  },
  {
    name: "90_SyncLog",
    primaryKey: "run_id",
    keyColumn: "run_id",
    columns: ["run_id", "run_type", "started_at", "finished_at", "environment", "ghost_pages", "stripe_pages", "counts", "exception_count", "completed", "cursor", "error_summary", "code_version"],
  },
  {
    name: "99_Config",
    primaryKey: "config_key",
    keyColumn: "config_key",
    columns: ["config_key", "config_value_non_secret", "description", "updated_at", "updated_by"],
  },
];

export function definitionFor(name: string): SheetDefinition {
  const definition = SHEET_DEFINITIONS.find((item) => item.name === name);
  if (!definition) throw new Error(`UNKNOWN_SHEET:${name}`);
  return definition;
}
