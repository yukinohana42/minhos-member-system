import { exceptionKey } from "./keys";
import { isGrantActive, isNonTerminalSubscription, isStripeEntitlement } from "./state";
import type {
  AccessGrantRow,
  BillingSignalRow,
  ExceptionFinding,
  ExceptionRow,
  MemberRow,
  SubscriptionRow,
} from "./types";

export function findOperationalExceptions(input: {
  members: MemberRow[];
  subscriptions: SubscriptionRow[];
  grants: AccessGrantRow[];
  signals: BillingSignalRow[];
  now: Date;
}): ExceptionFinding[] {
  const findings: ExceptionFinding[] = [];
  const membersById = new Map(input.members.map((member) => [member.ghost_member_id, member]));
  const presentSubscriptions = input.subscriptions.filter((row) => row.source_present_stripe);

  for (const subscription of presentSubscriptions) {
    const ids = [subscription.stripe_subscription_id];
    if (subscription.stripe_status === "unpaid") {
      findings.push(finding("PAYMENT_UNPAID", "P1", "Stripe Subscription が unpaid です。", subscription, ids, true));
    } else if (subscription.stripe_status === "paused") {
      findings.push(finding("PAYMENT_PAUSED", "P1", "MVP非対応の paused Subscription です。", subscription, ids, true));
    } else if (subscription.stripe_status === "past_due") {
      findings.push(finding("PAYMENT_PAST_DUE", "P2", "支払回収中です。", subscription, ids));
    } else if (subscription.stripe_status === "trialing") {
      findings.push(finding("TRIAL_NOT_ALLOWED", "P1", "MVP設定外の trialing Subscription です。", subscription, ids, true));
    } else if (subscription.stripe_status === "incomplete") {
      findings.push(finding("PAYMENT_INCOMPLETE", "P2", "初回決済が未完了です。", subscription, ids));
    } else if (subscription.stripe_status === "unknown") {
      findings.push(finding("STRIPE_STATUS_UNKNOWN", "P1", "未知のStripe Subscription状態です。", subscription, ids, true));
    }
    if (subscription.collection_method === "send_invoice") {
      findings.push(finding("SEND_INVOICE_UNSUPPORTED", "P1", "MVP対象外のsend_invoice契約です。", subscription, ids, true));
    }
    if (subscription.pause_collection_behavior) {
      findings.push(finding("PAUSE_COLLECTION", "P1", "MVP非対応の pause_collection が設定されています。", subscription, ids, true));
    }
    if (subscription.latest_invoice_status === "open" || subscription.open_invoice_count > 0) {
      findings.push(finding("OPEN_INVOICE", "P2", "未払いの open Invoice があります。", subscription, ids));
    }
    const member = membersById.get(subscription.ghost_member_id);
    if (isNonTerminalSubscription(subscription.stripe_status) && (!member || !member.source_present_ghost)) {
      findings.push(finding("MISSING_GHOST_MEMBER", "P1", "課金継続中ですが対応するGhost会員がありません。", subscription, ids, true));
    }
  }

  const nonTerminalByOwner = new Map<string, SubscriptionRow[]>();
  for (const subscription of presentSubscriptions.filter((row) => isNonTerminalSubscription(row.stripe_status))) {
    const owner = subscription.minhos_member_id || subscription.stripe_customer_id;
    const group = nonTerminalByOwner.get(owner) ?? [];
    group.push(subscription);
    nonTerminalByOwner.set(owner, group);
  }
  for (const [owner, subscriptions] of nonTerminalByOwner) {
    if (owner && subscriptions.length > 1) {
      findings.push({
        exceptionKey: exceptionKey("DUPLICATE_SUBSCRIPTION", owner),
        exceptionType: "DUPLICATE_SUBSCRIPTION",
        severity: "P1",
        summary: `${subscriptions.length}件の非終端Subscriptionがあります。`,
        minhosMemberId: subscriptions[0]?.minhos_member_id ?? "",
        stripeCustomerId: subscriptions[0]?.stripe_customer_id ?? "",
        immediate: true,
      });
    }
  }

  for (const member of input.members.filter((row) => row.source_present_ghost && row.ghost_access_state === "paid")) {
    const hasStripe = presentSubscriptions.some(
      (subscription) => subscription.ghost_member_id === member.ghost_member_id && isStripeEntitlement(subscription.stripe_status),
    );
    const hasGrant = input.grants.some(
      (grant) =>
        grant.ghost_member_id === member.ghost_member_id &&
        grant.source_present_ghost &&
        isGrantActive(grant, input.now),
    );
    if (!hasStripe && !hasGrant) {
      findings.push({
        exceptionKey: exceptionKey("GHOST_ACCESS_WITHOUT_BILLING", member.ghost_member_id),
        exceptionType: "GHOST_ACCESS_WITHOUT_BILLING",
        severity: "P1",
        summary: "Ghostは有料アクセスですが対象Stripe契約または付与が見つかりません。",
        minhosMemberId: member.minhos_member_id,
        ghostMemberId: member.ghost_member_id,
      });
    }
  }

  for (const member of input.members.filter(
    (row) => row.source_present_ghost && !["free", "paid", "comped", "gift"].includes(row.ghost_member_status),
  )) {
    findings.push({
      exceptionKey: exceptionKey("GHOST_STATUS_UNKNOWN", member.ghost_member_id),
      exceptionType: "GHOST_STATUS_UNKNOWN",
      severity: "P2",
      summary: "未知のGhost member statusです。",
      minhosMemberId: member.minhos_member_id,
      ghostMemberId: member.ghost_member_id,
    });
  }

  for (const grant of input.grants.filter((row) => row.source_present_ghost && isGrantActive(row, input.now))) {
    if (!grant.grant_reason || !grant.approved_by) {
      findings.push({
        exceptionKey: exceptionKey("GRANT_APPROVAL_METADATA_MISSING", grant.grant_key),
        exceptionType: "GRANT_APPROVAL_METADATA_MISSING",
        severity: "P2",
        summary: "有効なcomped/gift付与の理由または承認者が未記録です。",
        minhosMemberId: grant.minhos_member_id,
        ghostMemberId: grant.ghost_member_id,
      });
    }
  }

  for (const signal of input.signals) {
    if (signal.object_type === "refund" && signal.needs_action) {
      findings.push({
        exceptionKey: exceptionKey("REFUND_REVIEW_REQUIRED", signal.refund_id),
        exceptionType: "REFUND_REVIEW_REQUIRED",
        severity: "P2",
        summary: "Refundの内容と会員対応を運営者が確認してください。",
        stripeCustomerId: signal.stripe_customer_id,
        stripeSubscriptionId: signal.stripe_subscription_id,
      });
    }
    if (signal.object_type === "dispute" && signal.needs_action) {
      findings.push({
        exceptionKey: exceptionKey("OPEN_DISPUTE", signal.dispute_id),
        exceptionType: "OPEN_DISPUTE",
        severity: "P1",
        summary: `未解決Dispute ${signal.dispute_id} があります。`,
        stripeCustomerId: signal.stripe_customer_id,
        stripeSubscriptionId: signal.stripe_subscription_id,
        immediate: true,
      });
    }
    if ((signal.object_type === "refund" || signal.object_type === "dispute") && !signal.stripe_subscription_id) {
      findings.push({
        exceptionKey: exceptionKey("UNMATCHED_BILLING_SIGNAL", signal.object_type, signal.stripe_object_id),
        exceptionType: "UNMATCHED_BILLING_SIGNAL",
        severity: signal.object_type === "dispute" ? "P1" : "P2",
        summary: `${signal.object_type}をSubscriptionへ安全に照合できません。`,
        stripeCustomerId: signal.stripe_customer_id,
        immediate: signal.object_type === "dispute",
      });
    }
  }

  return dedupeFindings(findings);
}

export function reconcileExceptionRows(input: {
  existing: ExceptionRow[];
  findings: ExceptionFinding[];
  runId: string;
  nowIso: string;
  newId: () => string;
}): ExceptionRow[] {
  const findingsByKey = new Map(input.findings.map((item) => [item.exceptionKey, item]));
  const existingByKey = new Map(input.existing.map((item) => [item.exception_key, item]));
  const rows: ExceptionRow[] = [];

  for (const finding of input.findings) {
    const previous = existingByKey.get(finding.exceptionKey);
    // A billing item can be replayed after its Sheet mutation succeeds but
    // before the cursor write becomes durable. The final reconcile in that
    // same run also observes the already-persisted finding. Count both paths
    // as one observation; otherwise one external event can manufacture the
    // second occurrence that unlocks a delayed notification.
    const sameRunObservation = previous?.related_sync_run_id === input.runId && previous.status !== "resolved";
    rows.push({
      exception_key: finding.exceptionKey,
      exception_id: previous?.exception_id || input.newId(),
      severity: finding.severity,
      exception_type: finding.exceptionType,
      minhos_member_id: finding.minhosMemberId ?? previous?.minhos_member_id ?? "",
      ghost_member_id: finding.ghostMemberId ?? previous?.ghost_member_id ?? "",
      stripe_customer_id: finding.stripeCustomerId ?? previous?.stripe_customer_id ?? "",
      stripe_subscription_id: finding.stripeSubscriptionId ?? previous?.stripe_subscription_id ?? "",
      first_detected_at: previous?.first_detected_at || input.nowIso,
      last_detected_at: sameRunObservation ? previous.last_detected_at : input.nowIso,
      occurrence_count: (previous?.occurrence_count ?? 0) + (sameRunObservation ? 0 : 1),
      last_notified_at: previous?.last_notified_at ?? "",
      suppressed_until: previous?.suppressed_until ?? "",
      summary: finding.summary,
      status: previous?.status === "ignored"
        ? "ignored"
        : previous?.status === "acknowledged"
          ? "acknowledged"
          : "open",
      assignee: previous?.assignee ?? "",
      resolution: previous?.status === "resolved" ? "" : previous?.resolution ?? "",
      resolved_at: "",
      related_sync_run_id: input.runId,
    });
  }

  for (const previous of input.existing) {
    if (findingsByKey.has(previous.exception_key)) continue;
    // Form submission exceptions have no writable RAW mirror in this service;
    // they remain open for explicit operator resolution.
    if (
      (previous.exception_type.startsWith("PROFILE_SUBMISSION_") ||
        previous.exception_type === "UNMATCHED_BILLING_SIGNAL" ||
        previous.exception_type === "BILLING_SCOPE_VIOLATION") &&
      previous.status !== "resolved"
    ) {
      rows.push({ ...previous });
      continue;
    }
    rows.push(
      previous.status === "resolved"
        ? { ...previous }
        : {
            ...previous,
            status: "resolved",
            resolved_at: input.nowIso,
            related_sync_run_id: input.runId,
          },
    );
  }

  return rows.sort((a, b) => a.exception_key.localeCompare(b.exception_key));
}

function finding(
  type: string,
  severity: "P1" | "P2" | "P3",
  summary: string,
  subscription: SubscriptionRow,
  identifiers: string[],
  immediate = false,
): ExceptionFinding {
  return {
    exceptionKey: exceptionKey(type, ...identifiers),
    exceptionType: type,
    severity,
    summary,
    minhosMemberId: subscription.minhos_member_id,
    ghostMemberId: subscription.ghost_member_id,
    stripeCustomerId: subscription.stripe_customer_id,
    stripeSubscriptionId: subscription.stripe_subscription_id,
    immediate,
  };
}

function dedupeFindings(findings: ExceptionFinding[]): ExceptionFinding[] {
  return [...new Map(findings.map((finding) => [finding.exceptionKey, finding])).values()].sort((a, b) =>
    a.exceptionKey.localeCompare(b.exceptionKey),
  );
}
