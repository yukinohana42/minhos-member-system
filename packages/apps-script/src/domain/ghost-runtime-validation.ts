import type { GhostMembersPage } from "./types";
import { isoFromUnix } from "./values";

const MEMBER_STATUSES = new Set(["free", "paid", "comped", "gift"]);
const SUBSCRIPTION_STATUSES = new Set([
  "active", "trialing", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused",
]);
const SYNTHETIC_TYPES = new Set(["comped", "complimentary", "gift"]);

export function validateGhostMembersPage(value: unknown): asserts value is GhostMembersPage {
  const page = record(value, "ghost_members");
  if (!Array.isArray(page.members)) throw new Error("SCHEMA_MISMATCH:ghost_members.members");
  page.members.forEach((member, index) => validateMember(member, `ghost_members.members.${index}`));
}

function validateMember(value: unknown, path: string): void {
  const member = record(value, path);
  requiredNonemptyString(member.id, `${path}.id`);
  if (typeof member.status !== "string" || !MEMBER_STATUSES.has(member.status)) {
    throw new Error(`SCHEMA_MISMATCH:${path}.status`);
  }
  requiredNonemptyString(member.email, `${path}.email`);
  optionalString(member.uuid, `${path}.uuid`);
  optionalString(member.name, `${path}.name`);
  optionalGhostDate(member.created_at, `${path}.created_at`);
  optionalGhostDate(member.updated_at, `${path}.updated_at`);
  optionalBoolean(member.comped, `${path}.comped`);
  if (!Array.isArray(member.tiers)) throw new Error(`SCHEMA_MISMATCH:${path}.tiers`);
  member.tiers.forEach((tier, index) => validateTier(tier, `${path}.tiers.${index}`));
  if (!Array.isArray(member.subscriptions)) throw new Error(`SCHEMA_MISMATCH:${path}.subscriptions`);
  const allowsSynthetic = member.status === "comped" || member.status === "gift" || member.comped === true;
  member.subscriptions.forEach((subscription, index) =>
    validateSubscription(subscription, `${path}.subscriptions.${index}`, allowsSynthetic),
  );
}

function validateTier(value: unknown, path: string): void {
  const tier = record(value, path);
  optionalStableId(tier.id, `${path}.id`);
  optionalStableId(tier.tier_id, `${path}.tier_id`);
  const id = stringOrEmpty(tier.id);
  const tierId = stringOrEmpty(tier.tier_id);
  if (!id && !tierId) throw new Error(`SCHEMA_MISMATCH:${path}.id`);
  optionalString(tier.name, `${path}.name`);
  optionalString(tier.type, `${path}.type`);
  optionalBoolean(tier.active, `${path}.active`);
}

function validateSubscription(value: unknown, path: string, allowsSynthetic: boolean): void {
  const subscription = record(value, path);
  if (!Object.prototype.hasOwnProperty.call(subscription, "id") || typeof subscription.id !== "string") {
    throw new Error(`SCHEMA_MISMATCH:${path}.id`);
  }
  if (subscription.id !== "" && subscription.id !== subscription.id.trim()) {
    throw new Error(`SCHEMA_MISMATCH:${path}.id`);
  }
  if (typeof subscription.status !== "string" || !SUBSCRIPTION_STATUSES.has(subscription.status)) {
    throw new Error(`SCHEMA_MISMATCH:${path}.status`);
  }
  if (!Object.prototype.hasOwnProperty.call(subscription, "customer")) {
    throw new Error(`SCHEMA_MISMATCH:${path}.customer`);
  }
  const customer = record(subscription.customer, `${path}.customer`);
  if (!Object.prototype.hasOwnProperty.call(customer, "id") || typeof customer.id !== "string") {
    throw new Error(`SCHEMA_MISMATCH:${path}.customer.id`);
  }
  if (customer.id !== "" && customer.id !== customer.id.trim()) {
    throw new Error(`SCHEMA_MISMATCH:${path}.customer.id`);
  }
  if (!Object.prototype.hasOwnProperty.call(customer, "name") ||
    !Object.prototype.hasOwnProperty.call(customer, "email")) {
    throw new Error(`SCHEMA_MISMATCH:${path}.customer.fields`);
  }
  optionalString(customer.name, `${path}.customer.name`);
  optionalString(customer.email, `${path}.customer.email`);

  const synthetic = subscription.id === "";
  const syntheticType = typeof subscription.type === "string" && SYNTHETIC_TYPES.has(subscription.type);
  const syntheticAllowed = allowsSynthetic || syntheticType || subscription.gift === true;
  if (synthetic) {
    if (customer.id !== "" || !syntheticAllowed) {
      throw new Error(`SCHEMA_MISMATCH:${path}.synthetic_subscription`);
    }
  } else if (!customer.id) {
    throw new Error(`SCHEMA_MISMATCH:${path}.customer.id`);
  }

  optionalString(subscription.type, `${path}.type`);
  optionalBoolean(subscription.gift, `${path}.gift`);
  optionalBoolean(subscription.cancel_at_period_end, `${path}.cancel_at_period_end`);
  optionalGhostDate(subscription.start_date, `${path}.start_date`);
  optionalGhostDate(subscription.current_period_start, `${path}.current_period_start`);
  optionalGhostDate(subscription.current_period_end, `${path}.current_period_end`);
  if (subscription.tier !== undefined && subscription.tier !== null) validateTier(subscription.tier, `${path}.tier`);
  if (subscription.price !== undefined && subscription.price !== null) {
    validatePrice(subscription.price, `${path}.price`, synthetic);
  }
  if (!synthetic && (!subscription.price || typeof subscription.price !== "object")) {
    throw new Error(`SCHEMA_MISMATCH:${path}.price`);
  }
}

function validatePrice(value: unknown, path: string, allowsEmptyId: boolean): void {
  const price = record(value, path);
  optionalStableId(price.id, `${path}.id`);
  optionalStableId(price.price_id, `${path}.price_id`);
  if (!allowsEmptyId && !stringOrEmpty(price.id) && !stringOrEmpty(price.price_id)) {
    throw new Error(`SCHEMA_MISMATCH:${path}.id`);
  }
  optionalString(price.nickname, `${path}.nickname`);
  optionalString(price.interval, `${path}.interval`);
  optionalString(price.type, `${path}.type`);
  optionalCurrency(price.currency, `${path}.currency`);
  optionalNonnegativeInteger(price.amount, `${path}.amount`);
  if (price.tier !== undefined && price.tier !== null) validateTier(price.tier, `${path}.tier`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`SCHEMA_MISMATCH:${path}`);
  return value as Record<string, unknown>;
}

function requiredNonemptyString(value: unknown, path: string): void {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`SCHEMA_MISMATCH:${path}`);
  }
}

function optionalStableId(value: unknown, path: string): void {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`SCHEMA_MISMATCH:${path}`);
  }
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined && value !== null && typeof value !== "string") throw new Error(`SCHEMA_MISMATCH:${path}`);
}

function optionalBoolean(value: unknown, path: string): void {
  if (value !== undefined && value !== null && typeof value !== "boolean") throw new Error(`SCHEMA_MISMATCH:${path}`);
}

function optionalGhostDate(value: unknown, path: string): void {
  if (value === undefined || value === null || value === "") return;
  // isoFromUnix enforces typed, non-negative safe-integer Unix timestamps or
  // parseable ISO strings and reports the source path on malformed fixtures.
  isoFromUnix(value, path);
}

function optionalCurrency(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`SCHEMA_MISMATCH:${path}`);
  }
}

function optionalNonnegativeInteger(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`SCHEMA_MISMATCH:${path}`);
  }
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
