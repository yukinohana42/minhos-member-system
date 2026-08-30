import type { StripeBillingState } from "./types";

export function normalizeEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function compactStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => (value ?? "").trim()).filter(Boolean))].sort();
}

export function idOf(value: string | { id: string } | null | undefined): string {
  return typeof value === "string" ? value : value?.id ?? "";
}

/**
 * Convert a Ghost ISO date or a Stripe Unix timestamp to canonical UTC ISO.
 *
 * Empty values are deliberately preserved as blank Sheet cells. Any other
 * value is treated as an external payload value and must be valid; callers
 * should pass the source path so malformed direct fixtures fail closed too.
 */
export function isoFromUnix(value: unknown, path = "date"): string {
  if (value === null || value === undefined || value === "") return "";

  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`SCHEMA_MISMATCH:${path}`);
    }
    const milliseconds = value * 1000;
    const date = new Date(milliseconds);
    if (!Number.isFinite(date.getTime())) throw new Error(`SCHEMA_MISMATCH:${path}`);
    return date.toISOString();
  }

  if (typeof value !== "string") throw new Error(`SCHEMA_MISMATCH:${path}`);
  const text = value.trim();
  // A numeric string is neither a Ghost ISO date nor a typed Unix timestamp.
  // Date.parse accepts some such strings as surprising calendar dates.
  if (!text || /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) {
    throw new Error(`SCHEMA_MISMATCH:${path}`);
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error(`SCHEMA_MISMATCH:${path}`);
  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime())) throw new Error(`SCHEMA_MISMATCH:${path}`);
  return date.toISOString();
}

export function asStripeStatus(value: string | null | undefined): StripeBillingState {
  const known: StripeBillingState[] = [
    "active",
    "trialing",
    "past_due",
    "unpaid",
    "canceled",
    "incomplete",
    "incomplete_expired",
    "paused",
  ];
  return known.includes(value as StripeBillingState) ? (value as StripeBillingState) : "unknown";
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
}

export function stableHash(value: unknown): string {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:rk|sk)_(?:live|test)_[A-Za-z0-9_\-]+\b/g, "[REDACTED_STRIPE_KEY]")
    .replace(/\b[a-f0-9]{20,}:[a-f0-9]{40,}\b/gi, "[REDACTED_GHOST_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi, "Bearer [REDACTED]")
    .slice(0, 1000);
}
