import { billingSignalKey } from "./keys";
import { validateStripeRuntimeResponse } from "./stripe-runtime-validation";
import type {
  BillingSignalRow,
  StripeChargeRaw,
  StripeDisputeRaw,
  StripeInvoiceRaw,
  StripePaymentIntentRaw,
  StripeRefundRaw,
} from "./types";
import { idOf, isoFromUnix } from "./values";

export interface BillingLookups {
  charges?: ReadonlyMap<string, StripeChargeRaw>;
  paymentIntents?: ReadonlyMap<string, StripePaymentIntentRaw>;
  invoices?: ReadonlyMap<string, StripeInvoiceRaw>;
  refundTotalsByCharge?: ReadonlyMap<string, number>;
}

interface BillingRelation {
  customerId: string;
  subscriptionId: string;
  invoiceId: string;
  charge: StripeChargeRaw | undefined;
}

export function mapInvoiceSignal(
  invoice: StripeInvoiceRaw,
  context: { runId: string; nowIso: string },
): BillingSignalRow {
  validateStripeRuntimeResponse("stripe_invoice", invoice);
  const needsAction = invoice.status === "open" || invoice.status === "uncollectible";
  return {
    signal_key: billingSignalKey("invoice", invoice.id),
    object_type: "invoice",
    stripe_object_id: invoice.id,
    stripe_event_id: "",
    stripe_subscription_id: invoiceSubscriptionId(invoice),
    stripe_customer_id: idOf(invoice.customer),
    invoice_id: invoice.id,
    refund_id: "",
    dispute_id: "",
    raw_status: invoice.status ?? "",
    signal_kind: invoice.status === "open" ? "open_invoice" : "latest_invoice",
    amount_minor: invoice.amount_due ?? invoice.amount_paid ?? 0,
    currency: invoice.currency ?? "",
    occurred_at: isoFromUnix(invoice.created, "stripe_invoice.created"),
    next_payment_attempt_at: isoFromUnix(invoice.next_payment_attempt, "stripe_invoice.next_payment_attempt"),
    needs_action: needsAction,
    resolved_at: needsAction ? "" : context.nowIso,
    last_seen_run_id: context.runId,
    last_synced_at: context.nowIso,
  };
}

export function mapRefundSignal(
  refund: StripeRefundRaw,
  lookups: BillingLookups,
  context: { runId: string; nowIso: string },
): BillingSignalRow {
  validateStripeRuntimeResponse("stripe_refund", refund);
  const relation = resolveBillingRelation(refund, lookups);
  const status = refund.status ?? "unknown";
  const pending = status === "pending" || status === "requires_action";
  const chargeAmount = relation.charge?.amount ?? 0;
  const authoritativeRefunded = relation.charge?.amount_refunded;
  const cumulativeRefunded = authoritativeRefunded ??
    (relation.charge ? lookups.refundTotalsByCharge?.get(relation.charge.id) : undefined) ??
    refund.amount;
  const fullyRefunded = chargeAmount > 0 && cumulativeRefunded >= chargeAmount;
  const scope = chargeAmount > 0 && refund.amount < chargeAmount && !fullyRefunded ? "partial" : "full_or_unknown";
  const successfulFullRefund = status === "succeeded" && scope === "full_or_unknown";
  const needsAction = pending || successfulFullRefund || !relation.subscriptionId;
  return {
    signal_key: billingSignalKey("refund", refund.id),
    object_type: "refund",
    stripe_object_id: refund.id,
    stripe_event_id: "",
    stripe_subscription_id: relation.subscriptionId,
    stripe_customer_id: relation.customerId,
    invoice_id: relation.invoiceId,
    refund_id: refund.id,
    dispute_id: "",
    raw_status: status,
    signal_kind: `${scope}_refund`,
    amount_minor: refund.amount,
    currency: refund.currency,
    occurred_at: isoFromUnix(refund.created, "stripe_refund.created"),
    next_payment_attempt_at: "",
    needs_action: needsAction,
    resolved_at: needsAction ? "" : context.nowIso,
    last_seen_run_id: context.runId,
    last_synced_at: context.nowIso,
  };
}

export function mapDisputeSignal(
  dispute: StripeDisputeRaw,
  lookups: BillingLookups,
  context: { runId: string; nowIso: string },
): BillingSignalRow {
  validateStripeRuntimeResponse("stripe_dispute", dispute);
  const relation = resolveBillingRelation(dispute, lookups);
  const status = dispute.status ?? "unknown";
  const open = !new Set(["won", "lost", "warning_closed"]).has(status);
  return {
    signal_key: billingSignalKey("dispute", dispute.id),
    object_type: "dispute",
    stripe_object_id: dispute.id,
    stripe_event_id: "",
    stripe_subscription_id: relation.subscriptionId,
    stripe_customer_id: relation.customerId,
    invoice_id: relation.invoiceId,
    refund_id: "",
    dispute_id: dispute.id,
    raw_status: status,
    signal_kind: open ? "open_dispute" : "closed_dispute",
    amount_minor: dispute.amount,
    currency: dispute.currency,
    occurred_at: isoFromUnix(dispute.created, "stripe_dispute.created"),
    next_payment_attempt_at: "",
    needs_action: open,
    resolved_at: open ? "" : context.nowIso,
    last_seen_run_id: context.runId,
    last_synced_at: context.nowIso,
  };
}

export function resolveBillingRelation(
  signal: Pick<StripeRefundRaw | StripeDisputeRaw, "charge" | "payment_intent">,
  lookups: BillingLookups,
): BillingRelation {
  const expandedCharge = typeof signal.charge === "object" && signal.charge ? signal.charge : undefined;
  const chargeId = idOf(signal.charge);
  const charge = expandedCharge ?? (chargeId ? lookups.charges?.get(chargeId) : undefined);
  if (charge) validateStripeRuntimeResponse("stripe_charge", charge);
  const expandedPaymentIntent =
    (typeof signal.payment_intent === "object" && signal.payment_intent ? signal.payment_intent : undefined) ??
    (charge && typeof charge.payment_intent === "object" ? charge.payment_intent : undefined);
  const paymentIntentId = idOf(signal.payment_intent) || idOf(charge?.payment_intent);
  const paymentIntent =
    expandedPaymentIntent ?? (paymentIntentId ? lookups.paymentIntents?.get(paymentIntentId) : undefined);
  if (paymentIntent) validateStripeRuntimeResponse("stripe_payment_intent", paymentIntent);
  const expandedInvoice =
    (charge && typeof charge.invoice === "object" ? charge.invoice : undefined) ??
    (paymentIntent && typeof paymentIntent.invoice === "object" ? paymentIntent.invoice : undefined);
  const invoiceId = idOf(charge?.invoice) || idOf(paymentIntent?.invoice);
  const invoice = expandedInvoice ?? (invoiceId ? lookups.invoices?.get(invoiceId) : undefined);
  if (invoice) validateStripeRuntimeResponse("stripe_invoice", invoice);

  return {
    charge,
    invoiceId: invoice?.id ?? invoiceId,
    subscriptionId: invoice ? invoiceSubscriptionId(invoice) : "",
    customerId: idOf(invoice?.customer) || idOf(paymentIntent?.customer) || idOf(charge?.customer),
  };
}

export function invoiceSubscriptionId(invoice: StripeInvoiceRaw): string {
  const legacy = idOf(invoice.subscription);
  if (legacy) return legacy;
  if (invoice.parent?.type && invoice.parent.type !== "subscription_details") return "";
  return idOf(invoice.parent?.subscription_details?.subscription);
}
