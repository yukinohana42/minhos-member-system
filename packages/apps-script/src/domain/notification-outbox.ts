import { notificationDeliveryBatch, type NotificationDecision } from "./notifications";
import { assertSafePropertyStoreWrites, assertSafePropertyValue, utf8ByteLength } from "./property-quota";
import type { ExceptionRow } from "./types";
import { stableHash } from "./values";

export const NOTIFICATION_OUTBOX_PROPERTY_PREFIX = "NOTIFICATION_OUTBOX_JSON:";
/**
 * Quarantine records intentionally live below the already-registered outbox
 * prefix.  This keeps the Script Properties registry backwards compatible
 * while making quarantine entries unambiguously different from item/legacy
 * outbox properties.
 */
export const NOTIFICATION_OUTBOX_QUARANTINE_PROPERTY_PREFIX =
  `${NOTIFICATION_OUTBOX_PROPERTY_PREFIX}QUARANTINE:`;
const MAX_OUTBOX_ITEMS = 1_000;
const MAX_OUTBOX_VALUE_BYTES_TOTAL = 200_000;
export const NOTIFICATION_OUTBOX_QUARANTINE_MAX_ITEMS = 1_000;
export const NOTIFICATION_OUTBOX_QUARANTINE_MAX_VALUE_BYTES_TOTAL = 200_000;

export interface NotificationOutboxPropertySource {
  propertyName: string;
  sourceKind: "item" | "legacy";
  items: NotificationOutboxItem[];
}

/** A parse failure contains hashes only; the source key/value are never retained. */
export interface NotificationOutboxPropertyIssue {
  propertyName: string;
  sourceKind: "item" | "legacy";
  reason: string;
  errorCode: string;
  valueHash: string;
  propertyHash: string;
  valueBytes: number;
  itemIndex?: number;
}

export interface NotificationOutboxPropertyParseResult {
  items: NotificationOutboxItem[];
  sources: NotificationOutboxPropertySource[];
  invalid: NotificationOutboxPropertyIssue[];
}

export interface NotificationOutboxQuarantineRecord {
  schemaVersion: 1;
  quarantineId: string;
  propertyHash: string;
  valueHash: string;
  sourceKind: "item" | "legacy";
  reason: string;
  valueBytes: number;
  quarantinedAt: string;
  itemIndex?: number;
}

export interface NotificationOutboxPropertyStore {
  getProperties(): Record<string, string>;
  write(name: string, value: string): unknown;
  remove(name: string): unknown;
}

export interface NotificationOutboxItem {
  notificationId: string;
  exceptionKey: string;
  kind: NotificationDecision["kind"];
  severity: string;
  enqueuedAt: string;
  deliveryState: "pending" | "sent";
}

export function parseNotificationOutbox(raw: string | null): NotificationOutboxItem[] {
  if (!raw) return [];
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { throw new Error("INVALID_NOTIFICATION_OUTBOX:json"); }
  if (!Array.isArray(value) || value.length > MAX_OUTBOX_ITEMS) throw new Error("INVALID_NOTIFICATION_OUTBOX:shape");
  const ids = new Set<string>();
  const parsed = value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`INVALID_NOTIFICATION_OUTBOX:item_${index}`);
    }
    const item = candidate as Partial<NotificationOutboxItem>;
    if (Object.keys(item).some((key) => ![
      "notificationId", "exceptionKey", "kind", "severity", "enqueuedAt", "deliveryState",
    ].includes(key)) ||
      typeof item.notificationId !== "string" || !/^n-[0-9a-f]{8}-[0-9a-f]{8}$/u.test(item.notificationId) ||
      typeof item.exceptionKey !== "string" || !item.exceptionKey || item.exceptionKey.length > 512 ||
      !["opened", "changed", "recovered"].includes(item.kind ?? "") ||
      typeof item.severity !== "string" || !item.severity || item.severity.length > 8 ||
      typeof item.enqueuedAt !== "string" || !Number.isFinite(Date.parse(item.enqueuedAt)) ||
      !["pending", "sent"].includes(item.deliveryState ?? "")) {
      throw new Error(`INVALID_NOTIFICATION_OUTBOX:item_${index}`);
    }
    if (ids.has(item.notificationId)) throw new Error("INVALID_NOTIFICATION_OUTBOX:duplicate");
    ids.add(item.notificationId);
    return item as NotificationOutboxItem;
  });
  assertNotificationOutboxCapacity(parsed);
  return parsed;
}

/** The durable payload contains no email, member name, or profile value. */
export function enqueueNotificationOutbox(
  existing: NotificationOutboxItem[],
  decisions: NotificationDecision[],
  enqueuedAt: string,
): NotificationOutboxItem[] {
  if (!Number.isFinite(Date.parse(enqueuedAt))) throw new Error("INVALID_NOTIFICATION_OUTBOX:enqueued_at");
  const byId = new Map(existing.map((item) => [item.notificationId, item]));
  for (const decision of decisions) {
    const material = {
      exceptionKey: decision.exceptionKey,
      kind: decision.kind,
      severity: decision.severity,
      summary: decision.summary,
    };
    const notificationId = `n-${stableHash(material).slice(6)}-${stableHash({ material }).slice(6)}`;
    if (!byId.has(notificationId)) {
      byId.set(notificationId, {
        notificationId,
        exceptionKey: decision.exceptionKey,
        kind: decision.kind,
        severity: decision.severity,
        enqueuedAt,
        deliveryState: "pending",
      });
    }
  }
  const next = [...byId.values()];
  assertNotificationOutboxCapacity(next);
  return next;
}

export function notificationOutboxPropertyName(notificationId: string, contextFingerprint: string): string {
  return `${NOTIFICATION_OUTBOX_PROPERTY_PREFIX}${notificationId}:${contextFingerprint}`;
}

export function serializeNotificationOutboxItem(item: NotificationOutboxItem): string {
  // Reuse the strict parser so callers cannot bypass field bounds.
  const parsed = parseNotificationOutbox(JSON.stringify([item]))[0]!;
  const value = JSON.stringify(parsed);
  assertSafePropertyValue(value, "NOTIFICATION_OUTBOX");
  return value;
}

export function parseNotificationOutboxProperties(
  properties: Record<string, string>,
  contextFingerprint: string,
): NotificationOutboxItem[] {
  const result = parseNotificationOutboxPropertiesTolerantly(properties, contextFingerprint);
  if (result.invalid.length) throw new Error(result.invalid[0]!.errorCode);
  return result.items;
}

/**
 * Parse each namespaced property independently.  A malformed item does not
 * poison valid siblings; callers must persist the returned `invalid` entries
 * before deleting their source properties.
 */
export function parseNotificationOutboxPropertiesTolerantly(
  properties: Record<string, string>,
  contextFingerprint: string,
): NotificationOutboxPropertyParseResult {
  const suffix = `:${contextFingerprint}`;
  const legacyName = `${NOTIFICATION_OUTBOX_PROPERTY_PREFIX}${contextFingerprint}`;
  const items: NotificationOutboxItem[] = [];
  const sources: NotificationOutboxPropertySource[] = [];
  const invalid: NotificationOutboxPropertyIssue[] = [];
  const ids = new Set<string>();

  const entries = Object.entries(properties).sort(([left], [right]) => left.localeCompare(right));
  // Canonical per-item properties win over the legacy aggregate.  This is
  // important after a crash between legacy migration and aggregate deletion:
  // replay must not reinterpret already-migrated items as new duplicates.
  for (const [name, value] of entries) {
    if (
      name === legacyName ||
      !name.startsWith(NOTIFICATION_OUTBOX_PROPERTY_PREFIX) ||
      name.startsWith(NOTIFICATION_OUTBOX_QUARANTINE_PROPERTY_PREFIX) ||
      !name.endsWith(suffix)
    ) continue;

    const middle = name.slice(NOTIFICATION_OUTBOX_PROPERTY_PREFIX.length, -suffix.length);
    const parsed = parseSingleNotificationOutboxItem(value);
    if (!parsed.item) {
      invalid.push(createNotificationOutboxPropertyIssue(name, value, "item", parsed.errorCode ?? "item_0"));
      continue;
    }
    if (
      parsed.item.notificationId !== middle ||
      name !== notificationOutboxPropertyName(parsed.item.notificationId, contextFingerprint)
    ) {
      invalid.push(createNotificationOutboxPropertyIssue(name, value, "item", "property_key"));
      continue;
    }
    if (ids.has(parsed.item.notificationId)) {
      invalid.push(createNotificationOutboxPropertyIssue(name, value, "item", "duplicate"));
      continue;
    }
    ids.add(parsed.item.notificationId);
    items.push(parsed.item);
    sources.push({ propertyName: name, sourceKind: "item", items: [parsed.item] });
  }
  for (const [name, value] of entries) {
    if (name !== legacyName) continue;
    parseLegacyNotificationOutboxProperty({
      name,
      value,
      ids,
      items,
      sources,
      invalid,
    });
  }

  assertNotificationOutboxCapacity(items);
  return { items, sources, invalid };
}

/**
 * Persist hash-only quarantine records.  This function deliberately does not
 * delete source properties; `repairNotificationOutboxProperties` performs
 * migration and source deletion only after this write phase succeeds.
 */
export function persistNotificationOutboxQuarantine(
  properties: NotificationOutboxPropertyStore | GoogleAppsScript.Properties.Properties,
  result: NotificationOutboxPropertyParseResult,
  contextFingerprint: string,
  quarantinedAt: string,
): NotificationOutboxQuarantineRecord[] {
  const store = toNotificationOutboxPropertyStore(properties);
  if (!result.invalid.length) return [];
  if (!Number.isFinite(Date.parse(quarantinedAt))) {
    throw new Error("INVALID_NOTIFICATION_OUTBOX:quarantine_at");
  }

  const records = createNotificationOutboxQuarantineRecords(result.invalid, contextFingerprint, quarantinedAt);
  const current = store.getProperties();
  const writes: Array<{ name: string; value: string }> = [];
  for (const record of records) {
    const name = notificationOutboxQuarantinePropertyName(record, contextFingerprint);
    const value = serializeNotificationOutboxQuarantineRecord(record);
    const existing = current[name];
    if (existing === undefined) {
      writes.push({ name, value });
    } else if (!sameNotificationOutboxQuarantine(existing, record)) {
      // A deterministic key colliding with different metadata is unsafe to
      // overwrite.  Leave the source intact and fail closed.  A matching
      // record is accepted even when its timestamp differs: this is the
      // idempotent replay path after a source-delete failure.
      throw new Error("NOTIFICATION_OUTBOX_QUARANTINE_CONFLICT:P1");
    }
  }

  assertNotificationOutboxQuarantineCapacity(current, writes);
  assertSafePropertyStoreWrites(current, writes, "NOTIFICATION_OUTBOX_QUARANTINE");
  for (const write of writes) store.write(write.name, write.value);
  return records;
}

/**
 * Repair one environment's outbox under its caller's ScriptLock.  Legacy
 * aggregate items are first copied to canonical per-item properties so that a
 * corrupt sibling can be removed without losing valid pending work.
 */
export function repairNotificationOutboxProperties(
  properties: NotificationOutboxPropertyStore | GoogleAppsScript.Properties.Properties,
  contextFingerprint: string,
  nowIso: string,
): NotificationOutboxItem[] {
  const store = toNotificationOutboxPropertyStore(properties);
  const snapshot = store.getProperties();
  const result = parseNotificationOutboxPropertiesTolerantly(snapshot, contextFingerprint);
  const legacySources = result.sources.filter((source) => source.sourceKind === "legacy");
  const invalidNames = new Set(result.invalid.map((issue) => issue.propertyName));
  const validItemIds = new Set(
    result.sources
      .filter((source) => source.sourceKind === "item")
      .flatMap((source) => source.items.map((item) => item.notificationId)),
  );

  // The quarantine write is intentionally the first mutation.  If it throws,
  // no source is deleted and no valid sibling is delivered by the caller.
  persistNotificationOutboxQuarantine(store, result, contextFingerprint, nowIso);

  const migrationNames = new Set<string>();
  for (const source of legacySources) {
    for (const item of source.items) {
      if (validItemIds.has(item.notificationId)) continue;
      const name = notificationOutboxPropertyName(item.notificationId, contextFingerprint);
      const value = serializeNotificationOutboxItem(item);
      // Set even when a malformed property already occupies the canonical
      // name.  Its quarantine record was persisted above, and this replacement
      // keeps the valid legacy sibling durable.
      assertSafePropertyStoreWrites(store.getProperties(), [{ name, value }], "NOTIFICATION_OUTBOX_MIGRATION");
      store.write(name, value);
      migrationNames.add(name);
    }
  }

  const deleteNames = new Set<string>([
    ...invalidNames,
    ...legacySources.map((source) => source.propertyName),
  ]);
  for (const name of migrationNames) deleteNames.delete(name);
  for (const name of deleteNames) store.remove(name);
  return result.items;
}

export function createNotificationOutboxQuarantineRecords(
  issues: NotificationOutboxPropertyIssue[],
  contextFingerprint: string,
  quarantinedAt: string,
): NotificationOutboxQuarantineRecord[] {
  const unique = new Map<string, NotificationOutboxQuarantineRecord>();
  for (const issue of issues) {
    const reason = issue.reason.replace(/[^A-Za-z0-9_:.\-]/gu, "_").slice(0, 64) || "invalid";
    const propertyHash = /^fnv1a-[0-9a-f]{8}$/u.test(issue.propertyHash)
      ? issue.propertyHash
      : stableHash(issue.propertyHash);
    const valueHash = /^fnv1a-[0-9a-f]{8}$/u.test(issue.valueHash)
      ? issue.valueHash
      : stableHash(issue.valueHash);
    const valueBytes = Number.isSafeInteger(issue.valueBytes) && issue.valueBytes >= 0
      ? issue.valueBytes
      : 0;
    const rawItemIndex = issue.itemIndex;
    const itemIndex = Number.isSafeInteger(rawItemIndex) && rawItemIndex !== undefined && rawItemIndex >= 0
      ? rawItemIndex
      : undefined;
    const material = {
      contextFingerprint,
      propertyHash,
      valueHash,
      sourceKind: issue.sourceKind,
      reason,
      itemIndex: itemIndex ?? null,
    };
    const quarantineId = `q-${stableHash(material).slice(6)}-${stableHash({ material, valueBytes }).slice(6)}`;
    const record: NotificationOutboxQuarantineRecord = {
      schemaVersion: 1,
      quarantineId,
      propertyHash,
      valueHash,
      sourceKind: issue.sourceKind,
      reason,
      valueBytes,
      quarantinedAt,
      ...(itemIndex === undefined ? {} : { itemIndex }),
    };
    unique.set(quarantineId, record);
  }
  return [...unique.values()];
}

export function notificationOutboxQuarantinePropertyName(
  record: Pick<NotificationOutboxQuarantineRecord, "quarantineId">,
  contextFingerprint: string,
): string {
  return `${NOTIFICATION_OUTBOX_QUARANTINE_PROPERTY_PREFIX}${contextFingerprint}:${record.quarantineId}`;
}

export function serializeNotificationOutboxQuarantineRecord(record: NotificationOutboxQuarantineRecord): string {
  if (record.schemaVersion !== 1 ||
    !/^q-[0-9a-f]{8}-[0-9a-f]{8}$/u.test(record.quarantineId) ||
    !/^fnv1a-[0-9a-f]{8}$/u.test(record.propertyHash) ||
    !/^fnv1a-[0-9a-f]{8}$/u.test(record.valueHash) ||
    !["item", "legacy"].includes(record.sourceKind) ||
    !/^[A-Za-z0-9_:.\-]{1,64}$/u.test(record.reason) ||
    !Number.isSafeInteger(record.valueBytes) || record.valueBytes < 0 ||
    !Number.isFinite(Date.parse(record.quarantinedAt)) ||
    (record.itemIndex !== undefined && (!Number.isSafeInteger(record.itemIndex) || record.itemIndex < 0))) {
    throw new Error("INVALID_NOTIFICATION_OUTBOX_QUARANTINE");
  }
  const value = JSON.stringify(record);
  assertSafePropertyValue(value, "NOTIFICATION_OUTBOX_QUARANTINE");
  return value;
}

function sameNotificationOutboxQuarantine(
  existingRaw: string,
  expected: NotificationOutboxQuarantineRecord,
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(existingRaw) as unknown;
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const existing = value as Partial<NotificationOutboxQuarantineRecord>;
  const allowed = [
    "itemIndex", "propertyHash", "quarantineId", "quarantinedAt", "reason", "schemaVersion",
    "sourceKind", "valueBytes", "valueHash",
  ];
  const actualKeys = Object.keys(existing).sort();
  const expectedKeys = allowed.filter((key) => key !== "itemIndex" || expected.itemIndex !== undefined).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    existing.schemaVersion === expected.schemaVersion &&
    existing.quarantineId === expected.quarantineId &&
    existing.propertyHash === expected.propertyHash &&
    existing.valueHash === expected.valueHash &&
    existing.sourceKind === expected.sourceKind &&
    existing.reason === expected.reason &&
    existing.valueBytes === expected.valueBytes &&
    (existing.itemIndex ?? undefined) === (expected.itemIndex ?? undefined) &&
    typeof existing.quarantinedAt === "string" && Number.isFinite(Date.parse(existing.quarantinedAt));
}

function toNotificationOutboxPropertyStore(
  properties: NotificationOutboxPropertyStore | GoogleAppsScript.Properties.Properties,
): NotificationOutboxPropertyStore {
  if ("write" in properties && "remove" in properties) return properties;
  const nativeProperties = properties as GoogleAppsScript.Properties.Properties;
  return {
    getProperties: () => nativeProperties.getProperties(),
    write: nativeProperties.setProperty.bind(nativeProperties),
    remove: nativeProperties.deleteProperty.bind(nativeProperties),
  };
}

interface ParsedNotificationOutboxItem {
  item: NotificationOutboxItem | null;
  errorCode?: string;
}

function parseLegacyNotificationOutboxProperty(input: {
  name: string;
  value: string;
  ids: Set<string>;
  items: NotificationOutboxItem[];
  sources: NotificationOutboxPropertySource[];
  invalid: NotificationOutboxPropertyIssue[];
}): void {
  let value: unknown;
  try {
    value = JSON.parse(input.value) as unknown;
  } catch {
    input.invalid.push(createNotificationOutboxPropertyIssue(input.name, input.value, "legacy", "json"));
    return;
  }
  if (!Array.isArray(value)) {
    input.invalid.push(createNotificationOutboxPropertyIssue(input.name, input.value, "legacy", "shape"));
    return;
  }
  // An oversized aggregate may contain otherwise valid work.  Do not treat a
  // quota violation as discardable corruption; fail closed and leave the
  // source available for an operator/repair run.
  if (value.length > MAX_OUTBOX_ITEMS) {
    throw new Error("NOTIFICATION_OUTBOX_CAPACITY_EXCEEDED:P1");
  }

  const sourceItems: NotificationOutboxItem[] = [];
  value.forEach((candidate, index) => {
    const parsed = parseNotificationOutboxCandidate(candidate, index);
    if (!parsed.item) {
      input.invalid.push(createNotificationOutboxPropertyIssue(
        input.name,
        input.value,
        "legacy",
        parsed.errorCode ?? `item_${index}`,
        index,
      ));
      return;
    }
    if (input.ids.has(parsed.item.notificationId)) {
      input.invalid.push(createNotificationOutboxPropertyIssue(
        input.name,
        input.value,
        "legacy",
        "duplicate",
        index,
      ));
      return;
    }
    input.ids.add(parsed.item.notificationId);
    input.items.push(parsed.item);
    sourceItems.push(parsed.item);
  });
  input.sources.push({ propertyName: input.name, sourceKind: "legacy", items: sourceItems });
}

function parseSingleNotificationOutboxItem(raw: string): ParsedNotificationOutboxItem {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { item: null, errorCode: "json" };
  }
  return parseNotificationOutboxCandidate(value, 0);
}

function parseNotificationOutboxCandidate(candidate: unknown, index: number): ParsedNotificationOutboxItem {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { item: null, errorCode: `item_${index}` };
  }
  const item = candidate as Partial<NotificationOutboxItem>;
  if (Object.keys(item).some((key) => ![
    "notificationId", "exceptionKey", "kind", "severity", "enqueuedAt", "deliveryState",
  ].includes(key)) ||
    typeof item.notificationId !== "string" || !/^n-[0-9a-f]{8}-[0-9a-f]{8}$/u.test(item.notificationId) ||
    typeof item.exceptionKey !== "string" || !item.exceptionKey || item.exceptionKey.length > 512 ||
    !["opened", "changed", "recovered"].includes(item.kind ?? "") ||
    typeof item.severity !== "string" || !item.severity || item.severity.length > 8 ||
    typeof item.enqueuedAt !== "string" || !Number.isFinite(Date.parse(item.enqueuedAt)) ||
    !["pending", "sent"].includes(item.deliveryState ?? "")) {
    return { item: null, errorCode: `item_${index}` };
  }
  return { item: item as NotificationOutboxItem };
}

function createNotificationOutboxPropertyIssue(
  propertyName: string,
  rawValue: string,
  sourceKind: "item" | "legacy",
  errorCode: string,
  itemIndex?: number,
): NotificationOutboxPropertyIssue {
  const reason = errorCode.replace(/^INVALID_NOTIFICATION_OUTBOX:/u, "").slice(0, 64) || "invalid";
  return {
    propertyName,
    sourceKind,
    reason,
    errorCode: `INVALID_NOTIFICATION_OUTBOX:${reason}`,
    valueHash: stableHash(rawValue),
    propertyHash: stableHash(propertyName),
    valueBytes: utf8ByteLength(rawValue),
    ...(itemIndex === undefined ? {} : { itemIndex }),
  };
}

function assertNotificationOutboxQuarantineCapacity(
  current: Record<string, string>,
  writes: Array<{ name: string; value: string }>,
): void {
  const existing = Object.entries(current).filter(([name]) =>
    name.startsWith(NOTIFICATION_OUTBOX_QUARANTINE_PROPERTY_PREFIX));
  if (existing.length + writes.length > NOTIFICATION_OUTBOX_QUARANTINE_MAX_ITEMS) {
    throw new Error("NOTIFICATION_OUTBOX_QUARANTINE_CAPACITY_EXCEEDED:P1");
  }
  const totalBytes = existing.reduce((total, [, value]) => total + utf8ByteLength(value), 0) +
    writes.reduce((total, write) => total + utf8ByteLength(write.value), 0);
  if (totalBytes > NOTIFICATION_OUTBOX_QUARANTINE_MAX_VALUE_BYTES_TOTAL) {
    throw new Error("NOTIFICATION_OUTBOX_QUARANTINE_CAPACITY_EXCEEDED:P1");
  }
}

export function planNotificationOutboxDelivery(input: {
  outbox: NotificationOutboxItem[];
  rows: ExceptionRow[];
  limit?: number;
}): {
  deliverItems: NotificationOutboxItem[];
  sentItems: NotificationOutboxItem[];
  decisions: NotificationDecision[];
} {
  const rowsByKey = new Map(input.rows.map((row) => [row.exception_key, row]));
  const ordered = sortNotificationOutboxItems(input.outbox);
  const pending = ordered.filter((item) => item.deliveryState === "pending");
  const deliverItems = pending.slice(0, input.limit ?? 50);
  const decisions = notificationDeliveryBatch(deliverItems.map((item) => {
    const row = rowsByKey.get(item.exceptionKey);
    return {
      exceptionKey: item.exceptionKey,
      kind: item.kind,
      severity: item.severity,
      summary: row?.summary ?? "例外台帳行の書込または参照に失敗しました。通知IDを使って実行ログを確認してください。",
    };
  }), input.limit ?? 50);
  return {
    deliverItems,
    sentItems: ordered.filter((item) => item.deliveryState === "sent"),
    decisions,
  };
}

/**
 * Property names are hash-derived and therefore carry no causal ordering.
 * Deliver oldest state transitions first; events created at the same instant
 * follow opened -> changed -> recovered, then notification ID for a stable
 * replay order across Apps Script runtimes.
 */
export function sortNotificationOutboxItems(
  items: readonly NotificationOutboxItem[],
): NotificationOutboxItem[] {
  const kindOrder: Record<NotificationOutboxItem["kind"], number> = {
    opened: 0,
    changed: 1,
    recovered: 2,
  };
  return [...items].sort((left, right) => {
    const timeOrder = Date.parse(left.enqueuedAt) - Date.parse(right.enqueuedAt);
    if (timeOrder !== 0) return timeOrder;
    const transitionOrder = kindOrder[left.kind] - kindOrder[right.kind];
    if (transitionOrder !== 0) return transitionOrder;
    return left.notificationId.localeCompare(right.notificationId);
  });
}

export function markNotificationOutboxSent(
  outbox: NotificationOutboxItem[],
  items: NotificationOutboxItem[],
): NotificationOutboxItem[] {
  const ids = new Set(items.map((item) => item.notificationId));
  return outbox.map((item) => ids.has(item.notificationId) ? { ...item, deliveryState: "sent" } : item);
}

export function completeNotificationOutboxItems(
  outbox: NotificationOutboxItem[],
  items: NotificationOutboxItem[],
): NotificationOutboxItem[] {
  const ids = new Set(items.map((item) => item.notificationId));
  return outbox.filter((item) => !ids.has(item.notificationId));
}

export function notificationDecisionsForItems(
  items: NotificationOutboxItem[],
  rows: ExceptionRow[],
): NotificationDecision[] {
  const rowsByKey = new Map(rows.map((row) => [row.exception_key, row]));
  return items.map((item) => {
    const row = rowsByKey.get(item.exceptionKey);
    return {
      exceptionKey: item.exceptionKey,
      kind: item.kind,
      severity: item.severity,
      summary: row?.summary ?? "例外台帳行の書込または参照に失敗しました。通知IDを使って実行ログを確認してください。",
    };
  });
}

function assertNotificationOutboxCapacity(items: NotificationOutboxItem[]): void {
  if (items.length > MAX_OUTBOX_ITEMS) throw new Error("NOTIFICATION_OUTBOX_CAPACITY_EXCEEDED:P1");
  let totalBytes = 0;
  for (const item of items) {
    const value = JSON.stringify(item);
    assertSafePropertyValue(value, "NOTIFICATION_OUTBOX");
    totalBytes += utf8ByteLength(value);
  }
  if (totalBytes > MAX_OUTBOX_VALUE_BYTES_TOTAL) throw new Error("NOTIFICATION_OUTBOX_CAPACITY_EXCEEDED:P1");
}
