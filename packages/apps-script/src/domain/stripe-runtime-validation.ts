const SUBSCRIPTION_STATUSES = new Set([
  "active", "trialing", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused",
]);
const INVOICE_STATUSES = new Set(["draft", "open", "paid", "uncollectible", "void"]);
const REFUND_STATUSES = new Set(["pending", "requires_action", "succeeded", "failed", "canceled"]);
const DISPUTE_STATUSES = new Set([
  "warning_needs_response", "warning_under_review", "warning_closed", "needs_response", "under_review", "won", "lost",
]);
const COLLECTION_METHODS = new Set(["charge_automatically", "send_invoice"]);
const PAUSE_BEHAVIORS = new Set(["keep_as_draft", "mark_uncollectible", "void"]);

export function validateStripeRuntimeResponse(shapeName: string, value: unknown): void {
  const object = record(value, shapeName);
  switch (shapeName) {
    case "stripe_account":
    case "stripe_product":
      requiredId(object, shapeName);
      return;
    case "stripe_price":
      requiredId(object, shapeName);
      validateRequiredReference(object.product, `${shapeName}.product`);
      validatePriceFields(object, shapeName);
      return;
    case "stripe_subscription":
      validateSubscription(object, shapeName);
      return;
    case "stripe_invoice":
      validateInvoice(object, shapeName);
      return;
    case "stripe_refund":
      validateRefund(object, shapeName);
      return;
    case "stripe_dispute":
      validateDispute(object, shapeName);
      return;
    case "stripe_charge":
      validateCharge(object, shapeName);
      return;
    case "stripe_payment_intent":
      validatePaymentIntent(object, shapeName);
      return;
    default:
      if (shapeName.startsWith("stripe_")) requiredId(object, shapeName);
  }
}

export function validateStripeRuntimeList(shapeName: string, value: unknown): void {
  const list = record(value, shapeName);
  if (list.object !== "list" || !Array.isArray(list.data) || typeof list.has_more !== "boolean") {
    throw new Error(`SCHEMA_MISMATCH:${shapeName}.list`);
  }
  const singular = shapeName === "stripe_subscriptions"
    ? "stripe_subscription"
    : shapeName === "stripe_open_invoices"
      ? "stripe_invoice"
      : shapeName === "stripe_refunds"
        ? "stripe_refund"
        : shapeName === "stripe_disputes"
          ? "stripe_dispute"
          : "";
  if (singular) list.data.forEach((item) => validateStripeRuntimeResponse(singular, item));
}

function validateSubscription(object: Record<string, unknown>, path: string): void {
  requiredId(object, path);
  if (typeof object.livemode !== "boolean") throw new Error(`SCHEMA_MISMATCH:${path}.livemode`);
  if (typeof object.status !== "string" || !SUBSCRIPTION_STATUSES.has(object.status)) {
    throw new Error(`SCHEMA_MISMATCH:${path}.status`);
  }
  validateRequiredReference(object.customer, `${path}.customer`);
  if (object.collection_method !== undefined && object.collection_method !== null &&
    (typeof object.collection_method !== "string" || !COLLECTION_METHODS.has(object.collection_method))) {
    throw new Error(`SCHEMA_MISMATCH:${path}.collection_method`);
  }
  if (object.cancel_at_period_end !== undefined && typeof object.cancel_at_period_end !== "boolean") {
    throw new Error(`SCHEMA_MISMATCH:${path}.cancel_at_period_end`);
  }
  if (object.pause_collection !== undefined && object.pause_collection !== null) {
    const pause = record(object.pause_collection, `${path}.pause_collection`);
    if (pause.behavior !== undefined && pause.behavior !== null &&
      (typeof pause.behavior !== "string" || !PAUSE_BEHAVIORS.has(pause.behavior))) {
      throw new Error(`SCHEMA_MISMATCH:${path}.pause_collection.behavior`);
    }
  }
  validateOptionalUnixTimestamp(object.start_date, `${path}.start_date`);
  validateOptionalUnixTimestamp(object.current_period_start, `${path}.current_period_start`);
  validateOptionalUnixTimestamp(object.current_period_end, `${path}.current_period_end`);
  validateOptionalUnixTimestamp(object.canceled_at, `${path}.canceled_at`);
  validateOptionalUnixTimestamp(object.ended_at, `${path}.ended_at`);
  const items = record(object.items, `${path}.items`);
  if (!Array.isArray(items.data) || items.data.length === 0) throw new Error(`SCHEMA_MISMATCH:${path}.items.data`);
  for (const [index, itemValue] of items.data.entries()) {
    const item = record(itemValue, `${path}.items.data.${index}`);
    validateOptionalUnixTimestamp(item.current_period_start, `${path}.items.data.${index}.current_period_start`);
    validateOptionalUnixTimestamp(item.current_period_end, `${path}.items.data.${index}.current_period_end`);
    validatePrice(record(item.price, `${path}.items.data.${index}.price`), `${path}.items.data.${index}.price`);
  }
  if (typeof object.latest_invoice === "object" && object.latest_invoice !== null) {
    validateInvoice(record(object.latest_invoice, `${path}.latest_invoice`), `${path}.latest_invoice`);
  } else if (typeof object.latest_invoice === "string" && object.latest_invoice) {
    throw new Error(`SCHEMA_MISMATCH:${path}.latest_invoice.expand_required`);
  } else {
    validateOptionalReference(object.latest_invoice, `${path}.latest_invoice`);
  }
}

function validateInvoice(object: Record<string, unknown>, path: string): void {
  requiredId(object, path);
  if (typeof object.status !== "string" || !INVOICE_STATUSES.has(object.status)) {
    throw new Error(`SCHEMA_MISMATCH:${path}.status`);
  }
  validateRequiredReference(object.customer, `${path}.customer`);
  validateOptionalReference(object.subscription, `${path}.subscription`);
  if (object.payment_intent && typeof object.payment_intent === "object" && !Array.isArray(object.payment_intent)) {
    validatePaymentIntent(record(object.payment_intent, `${path}.payment_intent`), `${path}.payment_intent`);
  } else {
    validateOptionalReference(object.payment_intent, `${path}.payment_intent`);
  }
  validateOptionalNonnegativeInteger(object.amount_due, `${path}.amount_due`);
  validateOptionalNonnegativeInteger(object.amount_paid, `${path}.amount_paid`);
  validateOptionalCurrency(object.currency, `${path}.currency`);
  validateOptionalUnixTimestamp(object.created, `${path}.created`);
  validateOptionalUnixTimestamp(object.next_payment_attempt, `${path}.next_payment_attempt`);
  const statusTransitions = object.status_transitions;
  if (statusTransitions !== undefined && statusTransitions !== null) {
    const transitions = record(statusTransitions, `${path}.status_transitions`);
    validateOptionalUnixTimestamp(transitions.paid_at, `${path}.status_transitions.paid_at`);
  }
  const parent = object.parent;
  if (parent !== undefined && parent !== null) {
    const parentObject = record(parent, `${path}.parent`);
    if (parentObject.type !== undefined && parentObject.type !== null && typeof parentObject.type !== "string") {
      throw new Error(`SCHEMA_MISMATCH:${path}.parent.type`);
    }
    const details = parentObject.subscription_details;
    if (details !== undefined && details !== null) {
      validateOptionalReference(record(details, `${path}.parent.subscription_details`).subscription, `${path}.parent.subscription_details.subscription`);
    } else if (parentObject.type === "subscription_details") {
      throw new Error(`SCHEMA_MISMATCH:${path}.parent.subscription_details`);
    }
  }
}

function validateRefund(object: Record<string, unknown>, path: string): void {
  requiredId(object, path);
  if (typeof object.status !== "string" || !REFUND_STATUSES.has(object.status)) {
    throw new Error(`SCHEMA_MISMATCH:${path}.status`);
  }
  if (typeof object.amount !== "number" || !Number.isSafeInteger(object.amount) || object.amount < 0) {
    throw new Error(`SCHEMA_MISMATCH:${path}.amount`);
  }
  validateRequiredCurrency(object.currency, `${path}.currency`);
  validateOptionalUnixTimestamp(object.created, `${path}.created`);
  validateChargeOrReference(object.charge, `${path}.charge`);
  validatePaymentIntentOrReference(object.payment_intent, `${path}.payment_intent`);
}

function validateDispute(object: Record<string, unknown>, path: string): void {
  requiredId(object, path);
  if (typeof object.status !== "string" || !DISPUTE_STATUSES.has(object.status)) {
    throw new Error(`SCHEMA_MISMATCH:${path}.status`);
  }
  if (typeof object.amount !== "number" || !Number.isSafeInteger(object.amount) || object.amount < 0) {
    throw new Error(`SCHEMA_MISMATCH:${path}.amount`);
  }
  validateRequiredCurrency(object.currency, `${path}.currency`);
  validateOptionalUnixTimestamp(object.created, `${path}.created`);
  validateChargeOrReference(object.charge, `${path}.charge`);
  validatePaymentIntentOrReference(object.payment_intent, `${path}.payment_intent`);
}

function validateCharge(object: Record<string, unknown>, path: string): void {
  requiredId(object, path);
  if (object.amount === undefined || object.amount === null) throw new Error(`SCHEMA_MISMATCH:${path}.amount`);
  if (object.amount_refunded === undefined || object.amount_refunded === null) {
    throw new Error(`SCHEMA_MISMATCH:${path}.amount_refunded`);
  }
  validateOptionalNonnegativeInteger(object.amount, `${path}.amount`);
  validateOptionalNonnegativeInteger(object.amount_refunded, `${path}.amount_refunded`);
  validateOptionalReference(object.customer, `${path}.customer`);
  validateInvoiceOrReference(object.invoice, `${path}.invoice`);
  validatePaymentIntentOrReference(object.payment_intent, `${path}.payment_intent`);
}

function validatePaymentIntent(object: Record<string, unknown>, path: string): void {
  requiredId(object, path);
  validateOptionalReference(object.customer, `${path}.customer`);
  validateInvoiceOrReference(object.invoice, `${path}.invoice`);
  if (object.last_payment_error !== undefined && object.last_payment_error !== null) {
    record(object.last_payment_error, `${path}.last_payment_error`);
  }
}

function validateChargeOrReference(value: unknown, path: string): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    validateCharge(record(value, path), path);
  } else {
    validateOptionalReference(value, path);
  }
}

function validatePaymentIntentOrReference(value: unknown, path: string): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    validatePaymentIntent(record(value, path), path);
  } else {
    validateOptionalReference(value, path);
  }
}

function validateInvoiceOrReference(value: unknown, path: string): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    validateInvoice(record(value, path), path);
  } else {
    validateOptionalReference(value, path);
  }
}

function validatePrice(
  object: Record<string, unknown>,
  path: string,
): void {
  requiredId(object, path);
  validateRequiredReference(object.product, `${path}.product`);
  validatePriceFields(object, path);
}

function validatePriceFields(object: Record<string, unknown>, path: string): void {
  if (object.active !== undefined && object.active !== null && typeof object.active !== "boolean") {
    throw new Error(`SCHEMA_MISMATCH:${path}.active`);
  }
  validateOptionalNonnegativeInteger(object.unit_amount, `${path}.unit_amount`);
  validateOptionalCurrency(object.currency, `${path}.currency`);
  if (object.recurring !== undefined && object.recurring !== null) {
    const recurring = record(object.recurring, `${path}.recurring`);
    if (recurring.interval !== undefined && recurring.interval !== null &&
      (typeof recurring.interval !== "string" || !recurring.interval.trim() ||
        recurring.interval !== recurring.interval.trim())) {
      throw new Error(`SCHEMA_MISMATCH:${path}.recurring.interval`);
    }
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`SCHEMA_MISMATCH:${path}`);
  return value as Record<string, unknown>;
}

function requiredId(object: Record<string, unknown>, path: string): void {
  if (typeof object.id !== "string" || !object.id || object.id !== object.id.trim()) {
    throw new Error(`SCHEMA_MISMATCH:${path}.id`);
  }
}

function validateRequiredReference(value: unknown, path: string): void {
  if (typeof value === "string" && value && value === value.trim()) return;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id && id === id.trim()) return;
  }
  throw new Error(`SCHEMA_MISMATCH:${path}.id`);
}

function validateOptionalReference(value: unknown, path: string): void {
  if (value === undefined || value === null || value === "") return;
  validateRequiredReference(value, path);
}

function validateOptionalNonnegativeInteger(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`SCHEMA_MISMATCH:${path}`);
  }
}

function validateOptionalUnixTimestamp(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`SCHEMA_MISMATCH:${path}`);
  }
  const milliseconds = value * 1000;
  if (!Number.isFinite(milliseconds) || !Number.isFinite(new Date(milliseconds).getTime())) {
    throw new Error(`SCHEMA_MISMATCH:${path}`);
  }
}

function validateOptionalCurrency(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`SCHEMA_MISMATCH:${path}`);
  }
}

function validateRequiredCurrency(value: unknown, path: string): void {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`SCHEMA_MISMATCH:${path}`);
  }
}
