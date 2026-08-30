import type { BillingSignalRow } from "./types";

/** No lower bound is allowed until one complete Dispute history scan succeeds. */
export function disputeScanLowerBound(historyComplete: boolean, incrementalWatermark: number): number | undefined {
  return historyComplete ? incrementalWatermark : undefined;
}

export function unseenOpenInvoiceSignals(input: {
  signals: BillingSignalRow[];
  completedFullScan: boolean;
  runId: string;
}): BillingSignalRow[] {
  if (!input.completedFullScan) return [];
  return input.signals.filter((row) =>
    row.object_type === "invoice" &&
    row.needs_action &&
    row.last_seen_run_id !== input.runId,
  );
}

export interface UnseenOpenInvoicePage {
  rows: BillingSignalRow[];
  hasMore: boolean;
}

/**
 * Plan a deterministic bounded chunk of invoice retrieval work. The signal
 * key is an immutable Stripe-object-derived key, so a cursor can be committed
 * after every successful retrieve/upsert and a later invocation can resume
 * without relying on an in-memory array offset.
 */
export function planUnseenOpenInvoicePage(input: {
  signals: BillingSignalRow[];
  completedFullScan: boolean;
  runId: string;
  afterKey?: string;
  limit: number;
}): UnseenOpenInvoicePage {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("INVALID_UNSEEN_OPEN_INVOICE_PAGE_LIMIT");
  }
  const afterKey = input.afterKey ?? "";
  const candidates = unseenOpenInvoiceSignals({
    signals: input.signals,
    completedFullScan: input.completedFullScan,
    runId: input.runId,
  })
    .filter((row) => row.signal_key > afterKey)
    .sort((left, right) => left.signal_key < right.signal_key ? -1 : left.signal_key > right.signal_key ? 1 : 0);
  return {
    rows: candidates.slice(0, input.limit),
    hasMore: candidates.length > input.limit,
  };
}

/** Only authoritative paid/void retrievals resolve a previously actionable invoice. */
export function reconcileRetrievedInvoice(
  previous: BillingSignalRow,
  retrieved: BillingSignalRow,
  nowIso: string,
): BillingSignalRow {
  const terminal = retrieved.raw_status === "paid" || retrieved.raw_status === "void";
  const signalKind = retrieved.raw_status === "open"
    ? "open_invoice"
    : retrieved.raw_status === "uncollectible"
      ? "uncollectible_invoice"
      : terminal
        ? "closed_invoice"
        : "invoice_status_review";
  return {
    ...previous,
    ...retrieved,
    signal_kind: signalKind,
    needs_action: !terminal,
    resolved_at: terminal ? nowIso : "",
    last_synced_at: nowIso,
  };
}

/**
 * Refresh every actionable invoice omitted from the completed open-invoice
 * scan. Retrieval is deliberately keyed by the persisted invoice_id; callers
 * provide the read-only endpoint adapter and scope assertion in the callback.
 */
export function refreshUnseenOpenInvoiceSignals(input: {
  signals: BillingSignalRow[];
  completedFullScan: boolean;
  runId: string;
  nowIso: string;
  retrieveById: (invoiceId: string) => BillingSignalRow;
}): BillingSignalRow[] {
  const refreshed = new Map<string, BillingSignalRow>();
  for (const previous of unseenOpenInvoiceSignals(input)) {
    if (!previous.invoice_id) throw new Error("SCHEMA_MISMATCH:billing_signal.invoice_id");
    const retrieved = input.retrieveById(previous.invoice_id);
    refreshed.set(previous.signal_key, reconcileRetrievedInvoice(previous, retrieved, input.nowIso));
  }
  return refreshed.size
    ? input.signals.map((row) => refreshed.get(row.signal_key) ?? row)
    : input.signals;
}
