export const SECRET_PROPERTY_NAMES = ["GHOST_ADMIN_API_KEY", "STRIPE_RESTRICTED_KEY"] as const;
export const SUPPORTED_STRIPE_API_VERSION = "2025-02-24.acacia";

export interface SyncConfig {
  spreadsheetId: string;
  ghostAdminUrl: string;
  ghostSiteId: string;
  ghostAcceptVersion: string;
  stripeAccountId: string;
  stripeApiVersion: string;
  livemode: boolean;
  stripePriceIds: Set<string>;
  stripeProductIds: Set<string>;
  notificationEmail: string;
  backupFolderId: string;
  backupRetentionDays: number;
  backupMonthlyRetentionDays: number;
  maxRuntimeMs: number;
  watermarkOverlapSeconds: number;
  schemaVersion: number;
  codeVersion: string;
}

export interface SyncSecrets {
  ghostAdminApiKey: string;
  stripeRestrictedKey: string;
}

export function loadConfig(properties: GoogleAppsScript.Properties.Properties): SyncConfig {
  const get = (name: string): string => properties.getProperty(name)?.trim() ?? "";
  const required = (name: string): string => {
    const value = get(name);
    if (!value) throw new Error(`MISSING_CONFIGURATION:${name}`);
    return value;
  };
  const livemodeValue = required("STRIPE_LIVEMODE");
  if (livemodeValue !== "true" && livemodeValue !== "false") {
    throw new Error("STRIPE_LIVEMODE_MUST_BE_TRUE_OR_FALSE");
  }
  const livemode = livemodeValue === "true";
  const ghostAdminUrl = normalizeGhostAdminUrl(required("GHOST_ADMIN_URL"));

  const stripeApiVersion = required("STRIPE_API_VERSION");
  if (stripeApiVersion !== SUPPORTED_STRIPE_API_VERSION) {
    throw new Error(`UNSUPPORTED_STRIPE_API_VERSION:${stripeApiVersion}`);
  }

  return {
    spreadsheetId: required("SPREADSHEET_ID"),
    ghostAdminUrl,
    ghostSiteId: required("GHOST_SITE_ID"),
    ghostAcceptVersion: get("GHOST_ACCEPT_VERSION") || "v5.0",
    stripeAccountId: required("STRIPE_ACCOUNT_ID"),
    stripeApiVersion,
    livemode,
    stripePriceIds: parseCsvSet(required("STRIPE_PRICE_ALLOWLIST")),
    stripeProductIds: parseCsvSet(required("STRIPE_PRODUCT_ALLOWLIST")),
    notificationEmail: required("OPS_NOTIFICATION_EMAIL"),
    backupFolderId: required("BACKUP_FOLDER_ID"),
    backupRetentionDays: positiveNumber(get("BACKUP_RETENTION_DAYS"), 35),
    backupMonthlyRetentionDays: positiveNumber(get("BACKUP_MONTHLY_RETENTION_DAYS"), 730),
    maxRuntimeMs: runtimeBudget(get("MAX_RUNTIME_MS")),
    watermarkOverlapSeconds: positiveNumber(get("BILLING_WATERMARK_OVERLAP_SECONDS"), 172_800),
    schemaVersion: positiveNumber(get("SCHEMA_VERSION"), 1),
    codeVersion: get("CODE_VERSION") || "0.1.0",
  };
}

export function loadSecrets(properties: GoogleAppsScript.Properties.Properties, livemode: boolean): SyncSecrets {
  const ghostAdminApiKey = properties.getProperty("GHOST_ADMIN_API_KEY") ?? "";
  const stripeRestrictedKey = properties.getProperty("STRIPE_RESTRICTED_KEY") ?? "";
  if (!ghostAdminApiKey) throw new Error("MISSING_SECRET:GHOST_ADMIN_API_KEY");
  if (!stripeRestrictedKey) throw new Error("MISSING_SECRET:STRIPE_RESTRICTED_KEY");
  if (!stripeRestrictedKey.startsWith(livemode ? "rk_live_" : "rk_test_")) {
    throw new Error("STRIPE_RESTRICTED_KEY_ENVIRONMENT_MISMATCH");
  }
  return { ghostAdminApiKey, stripeRestrictedKey };
}

function parseCsvSet(value: string): Set<string> {
  const result = new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
  if (result.size === 0) throw new Error("ALLOWLIST_MUST_NOT_BE_EMPTY");
  return result;
}

function positiveNumber(value: string, fallback: number): number {
  const number = value ? Number(value) : fallback;
  if (!Number.isFinite(number) || number <= 0) throw new Error("CONFIGURATION_NUMBER_MUST_BE_POSITIVE");
  return number;
}

function runtimeBudget(value: string): number {
  const number = value ? Number(value) : 270_000;
  if (!Number.isInteger(number) || number < 30_000 || number > 300_000) {
    throw new Error("MAX_RUNTIME_MS_OUT_OF_SAFE_RANGE");
  }
  return number;
}
import { normalizeGhostAdminUrl } from "./domain/url-normalization";
