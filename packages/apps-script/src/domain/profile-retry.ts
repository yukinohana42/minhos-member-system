import { assertSafePropertyStoreWrites, assertSafePropertyValue, utf8ByteLength } from "./property-quota";
import { stableHash } from "./values";

export const PROFILE_RETRY_PROPERTY_PREFIX = "PROFILE_FORM_RETRY_QUEUE_JSON:";
export const PROFILE_RETRY_QUARANTINE_PROPERTY_PREFIX = "PROFILE_FORM_RETRY_QUARANTINE_JSON:";
export const PROFILE_RETRY_CORRUPTION_QUARANTINE_PROPERTY_PREFIX =
  `${PROFILE_RETRY_QUARANTINE_PROPERTY_PREFIX}CORRUPT:`;
const MAX_PROFILE_RETRY_ITEMS = 1_000;
const MAX_PROFILE_RETRY_VALUE_BYTES_TOTAL = 200_000;
export const PROFILE_RETRY_QUARANTINE_MAX_ITEMS = 1_000;
export const PROFILE_RETRY_QUARANTINE_MAX_VALUE_BYTES_TOTAL = 200_000;

export interface ProfileRetryItem {
  formId: string;
  responseId: string;
  queuedAt: string;
  failureCount?: number;
  nextAttemptAt?: string;
  lastFailureKind?: "missing_response" | "coordination_busy" | "processing_error";
}

export const PROFILE_RETRY_BATCH_LIMIT = 10;
export const PROFILE_RETRY_MAX_FAILURES = 5;

export interface ProfileRetryQuarantineRecord {
  quarantineId: string;
  formIdHash: string;
  responseIdHash: string;
  reason: "missing_response" | "processing_error";
  failureCount: number;
  quarantinedAt: string;
}

export interface ProfileRetryPropertyIssue {
  propertyName: string;
  sourceKind: "item" | "legacy";
  reason: string;
  propertyHash: string;
  valueHash: string;
  valueBytes: number;
  itemIndex?: number;
}

export interface ProfileRetryPropertySource {
  propertyName: string;
  sourceKind: "item" | "legacy";
  items: ProfileRetryItem[];
}

export interface ProfileRetryPropertyParseResult {
  items: ProfileRetryItem[];
  sources: ProfileRetryPropertySource[];
  invalid: ProfileRetryPropertyIssue[];
}

export interface ProfileRetryCorruptionQuarantineRecord {
  schemaVersion: 1;
  quarantineId: string;
  sourceKind: "item" | "legacy";
  reason: string;
  propertyHash: string;
  valueHash: string;
  valueBytes: number;
  quarantinedAt: string;
  itemIndex?: number;
}

export interface ProfileRetryPropertyStore {
  getProperties(): Record<string, string>;
  write(name: string, value: string): unknown;
  remove(name: string): unknown;
}

export function parseProfileRetryQueue(raw: string | null): ProfileRetryItem[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("INVALID_PROFILE_RETRY_QUEUE:json");
  }
  if (!Array.isArray(value) || value.length > MAX_PROFILE_RETRY_ITEMS) throw new Error("INVALID_PROFILE_RETRY_QUEUE:shape");
  const seen = new Set<string>();
  const parsed = value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`INVALID_PROFILE_RETRY_QUEUE:item_${index}`);
    }
    const item = candidate as Partial<ProfileRetryItem>;
    if (Object.keys(item).some((key) => ![
      "formId", "responseId", "queuedAt", "failureCount", "nextAttemptAt", "lastFailureKind",
    ].includes(key)) ||
      typeof item.formId !== "string" || !item.formId || item.formId.length > 256 ||
      typeof item.responseId !== "string" || !item.responseId || item.responseId.length > 256 ||
      typeof item.queuedAt !== "string" || !Number.isFinite(Date.parse(item.queuedAt)) ||
      (item.failureCount !== undefined &&
        (!Number.isInteger(item.failureCount) || item.failureCount < 0 || item.failureCount > PROFILE_RETRY_MAX_FAILURES)) ||
      (item.nextAttemptAt !== undefined &&
        (typeof item.nextAttemptAt !== "string" || !Number.isFinite(Date.parse(item.nextAttemptAt)))) ||
      (item.lastFailureKind !== undefined &&
        !["missing_response", "coordination_busy", "processing_error"].includes(item.lastFailureKind))) {
      throw new Error(`INVALID_PROFILE_RETRY_QUEUE:item_${index}`);
    }
    const key = `${item.formId}\u0000${item.responseId}`;
    if (seen.has(key)) throw new Error("INVALID_PROFILE_RETRY_QUEUE:duplicate");
    seen.add(key);
    return item as ProfileRetryItem;
  });
  assertProfileRetryCapacity(parsed);
  return parsed;
}

export function enqueueProfileRetry(queue: ProfileRetryItem[], item: ProfileRetryItem): ProfileRetryItem[] {
  const existing = queue.find((candidate) =>
    candidate.formId === item.formId && candidate.responseId === item.responseId);
  if (existing) return queue;
  const next = [...queue, item];
  assertProfileRetryCapacity(next);
  return next;
}

export function removeProfileRetry(queue: ProfileRetryItem[], item: Pick<ProfileRetryItem, "formId" | "responseId">): ProfileRetryItem[] {
  return queue.filter((candidate) =>
    candidate.formId !== item.formId || candidate.responseId !== item.responseId);
}

export function dueProfileRetryItems(
  queue: ProfileRetryItem[],
  nowIso: string,
  limit = PROFILE_RETRY_BATCH_LIMIT,
): ProfileRetryItem[] {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) throw new Error("INVALID_PROFILE_RETRY_NOW");
  if (!Number.isInteger(limit) || limit < 1 || limit > PROFILE_RETRY_BATCH_LIMIT) {
    throw new Error("INVALID_PROFILE_RETRY_BATCH_LIMIT");
  }
  return sortProfileRetryItems(queue)
    .filter((item) => !item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= nowMs)
    .slice(0, limit);
}

export function rescheduleProfileRetry(
  item: ProfileRetryItem,
  attemptedAt: string,
  kind: NonNullable<ProfileRetryItem["lastFailureKind"]>,
): ProfileRetryItem {
  const attemptedAtMs = Date.parse(attemptedAt);
  if (!Number.isFinite(attemptedAtMs)) throw new Error("INVALID_PROFILE_RETRY_ATTEMPTED_AT");
  const failureCount = Math.min(PROFILE_RETRY_MAX_FAILURES, (item.failureCount ?? 0) + 1);
  const delaySeconds = Math.min(3_600, 60 * 2 ** Math.max(0, failureCount - 1));
  return {
    ...item,
    failureCount,
    nextAttemptAt: new Date(attemptedAtMs + delaySeconds * 1_000).toISOString(),
    lastFailureKind: kind,
  };
}

export function shouldQuarantineProfileRetry(item: ProfileRetryItem): boolean {
  return (item.failureCount ?? 0) >= PROFILE_RETRY_MAX_FAILURES;
}

export function profileRetryQuarantineRecord(
  item: ProfileRetryItem,
  reason: ProfileRetryQuarantineRecord["reason"],
  quarantinedAt: string,
): ProfileRetryQuarantineRecord {
  if (!Number.isFinite(Date.parse(quarantinedAt))) throw new Error("INVALID_PROFILE_RETRY_QUARANTINE_AT");
  const formIdHash = stableHash({ formId: item.formId }).slice(6);
  const responseIdHash = stableHash({ responseId: item.responseId }).slice(6);
  const material = { formIdHash, responseIdHash, reason };
  return {
    quarantineId: `q-${stableHash(material).slice(6)}-${stableHash({ material }).slice(6)}`,
    formIdHash,
    responseIdHash,
    reason,
    failureCount: item.failureCount ?? 0,
    quarantinedAt,
  };
}

export function profileRetryQuarantinePropertyName(record: ProfileRetryQuarantineRecord, namespace: string): string {
  return `${PROFILE_RETRY_QUARANTINE_PROPERTY_PREFIX}${namespace}:${record.quarantineId}`;
}

export function serializeProfileRetryQuarantine(record: ProfileRetryQuarantineRecord): string {
  if (!/^q-[0-9a-f]{8}-[0-9a-f]{8}$/u.test(record.quarantineId) ||
    !/^[0-9a-f]{8}$/u.test(record.formIdHash) || !/^[0-9a-f]{8}$/u.test(record.responseIdHash) ||
    !["missing_response", "processing_error"].includes(record.reason) ||
    !Number.isInteger(record.failureCount) || record.failureCount < 0 ||
    !Number.isFinite(Date.parse(record.quarantinedAt))) {
    throw new Error("INVALID_PROFILE_RETRY_QUARANTINE");
  }
  const value = JSON.stringify(record);
  assertSafePropertyValue(value, "PROFILE_RETRY_QUARANTINE");
  return value;
}

export function persistProfileRetryProcessingQuarantine(
  properties: ProfileRetryPropertyStore | GoogleAppsScript.Properties.Properties,
  namespace: string,
  record: ProfileRetryQuarantineRecord,
): string {
  const store = toProfileRetryPropertyStore(properties);
  const name = profileRetryQuarantinePropertyName(record, namespace);
  const value = serializeProfileRetryQuarantine(record);
  const current = store.getProperties();
  const existing = current[name];
  if (existing !== undefined) {
    if (!sameProfileRetryProcessingQuarantine(existing, record)) {
      throw new Error("PROFILE_RETRY_QUARANTINE_CONFLICT:P1");
    }
    return name;
  }
  assertProfileRetryQuarantineCapacity(current, [{ name, value }]);
  assertSafePropertyStoreWrites(current, [{ name, value }], "PROFILE_RETRY_PROCESSING_QUARANTINE");
  store.write(name, value);
  if (store.getProperties()[name] !== value) {
    throw new Error("PROFILE_RETRY_QUARANTINE_WRITE_NOT_DURABLE");
  }
  return name;
}

function sameProfileRetryProcessingQuarantine(
  raw: string,
  expected: ProfileRetryQuarantineRecord,
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const existing = value as Partial<ProfileRetryQuarantineRecord>;
  const expectedKeys = [
    "failureCount", "formIdHash", "quarantineId", "quarantinedAt", "reason", "responseIdHash",
  ];
  const actualKeys = Object.keys(existing).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    existing.quarantineId === expected.quarantineId &&
    existing.formIdHash === expected.formIdHash &&
    existing.responseIdHash === expected.responseIdHash &&
    existing.reason === expected.reason &&
    existing.failureCount === expected.failureCount &&
    typeof existing.quarantinedAt === "string" && Number.isFinite(Date.parse(existing.quarantinedAt));
}

export function profileRetryItemId(item: Pick<ProfileRetryItem, "formId" | "responseId">): string {
  const material = { formId: item.formId, responseId: item.responseId };
  return `r-${stableHash(material).slice(6)}-${stableHash({ material }).slice(6)}`;
}

export function profileRetryPropertyName(item: Pick<ProfileRetryItem, "formId" | "responseId">, namespace: string): string {
  return `${PROFILE_RETRY_PROPERTY_PREFIX}${namespace}:${profileRetryItemId(item)}`;
}

export function serializeProfileRetryItem(item: ProfileRetryItem): string {
  const parsed = parseProfileRetryQueue(JSON.stringify([item]))[0]!;
  const value = JSON.stringify(parsed);
  assertSafePropertyValue(value, "PROFILE_RETRY_QUEUE");
  return value;
}

export function parseProfileRetryProperties(
  properties: Record<string, string>,
  namespace: string,
): ProfileRetryItem[] {
  const result = parseProfileRetryPropertiesTolerantly(properties, namespace);
  if (result.invalid.length) {
    throw new Error(`INVALID_PROFILE_RETRY_QUEUE:${result.invalid[0]!.reason}`);
  }
  return result.items;
}

export function parseProfileRetryPropertiesTolerantly(
  properties: Record<string, string>,
  namespace: string,
): ProfileRetryPropertyParseResult {
  const itemPrefix = `${PROFILE_RETRY_PROPERTY_PREFIX}${namespace}:`;
  const legacyName = `${PROFILE_RETRY_PROPERTY_PREFIX}${namespace}`;
  const items: ProfileRetryItem[] = [];
  const sources: ProfileRetryPropertySource[] = [];
  const invalid: ProfileRetryPropertyIssue[] = [];
  const ids = new Set<string>();
  const entries = Object.entries(properties).sort(([left], [right]) => left.localeCompare(right));

  // Canonical item properties win over a legacy aggregate during a replay
  // after migration succeeded but legacy deletion did not.
  for (const [name, value] of entries) {
    if (name === legacyName || !name.startsWith(itemPrefix)) continue;
    const parsed = parseProfileRetryCandidateValue(value);
    if (!parsed.item) {
      invalid.push(profileRetryPropertyIssue(name, value, "item", parsed.reason ?? "item"));
      continue;
    }
    if (name !== profileRetryPropertyName(parsed.item, namespace)) {
      invalid.push(profileRetryPropertyIssue(name, value, "item", "property_key"));
      continue;
    }
    const id = profileRetryItemId(parsed.item);
    if (ids.has(id)) {
      invalid.push(profileRetryPropertyIssue(name, value, "item", "duplicate"));
      continue;
    }
    ids.add(id);
    items.push(parsed.item);
    sources.push({ propertyName: name, sourceKind: "item", items: [parsed.item] });
  }

  const legacyRaw = properties[legacyName];
  if (legacyRaw !== undefined) {
    parseLegacyProfileRetryProperty(legacyName, legacyRaw, ids, items, sources, invalid);
  }

  const parsed = sortProfileRetryItems(items);
  assertProfileRetryCapacity(parsed);
  return { items: parsed, sources, invalid };
}

export function repairProfileRetryProperties(
  properties: ProfileRetryPropertyStore | GoogleAppsScript.Properties.Properties,
  namespace: string,
  nowIso: string,
): ProfileRetryItem[] {
  const store = toProfileRetryPropertyStore(properties);
  const snapshot = store.getProperties();
  const result = parseProfileRetryPropertiesTolerantly(snapshot, namespace);
  persistProfileRetryCorruptionQuarantine(store, result, namespace, nowIso);

  const canonicalIds = new Set(
    result.sources
      .filter((source) => source.sourceKind === "item")
      .flatMap((source) => source.items.map(profileRetryItemId)),
  );
  const migrationNames = new Set<string>();
  for (const source of result.sources.filter((candidate) => candidate.sourceKind === "legacy")) {
    for (const item of source.items) {
      if (canonicalIds.has(profileRetryItemId(item))) continue;
      const name = profileRetryPropertyName(item, namespace);
      const value = serializeProfileRetryItem(item);
      assertSafePropertyStoreWrites(store.getProperties(), [{ name, value }], "PROFILE_RETRY_MIGRATION");
      store.write(name, value);
      migrationNames.add(name);
    }
  }

  const deleteNames = new Set([
    ...result.invalid.map((issue) => issue.propertyName),
    ...result.sources.filter((source) => source.sourceKind === "legacy").map((source) => source.propertyName),
  ]);
  for (const name of migrationNames) deleteNames.delete(name);
  for (const name of deleteNames) store.remove(name);
  return result.items;
}

export function persistProfileRetryCorruptionQuarantine(
  properties: ProfileRetryPropertyStore | GoogleAppsScript.Properties.Properties,
  result: ProfileRetryPropertyParseResult,
  namespace: string,
  nowIso: string,
): ProfileRetryCorruptionQuarantineRecord[] {
  if (!Number.isFinite(Date.parse(nowIso))) throw new Error("INVALID_PROFILE_RETRY_QUARANTINE_AT");
  const store = toProfileRetryPropertyStore(properties);
  const current = store.getProperties();
  const records = result.invalid.map((issue) => profileRetryCorruptionQuarantineRecord(issue, namespace, nowIso));
  const unique = new Map(records.map((record) => [record.quarantineId, record]));
  const writes: Array<{ name: string; value: string }> = [];
  for (const record of unique.values()) {
    const name = `${PROFILE_RETRY_CORRUPTION_QUARANTINE_PROPERTY_PREFIX}${namespace}:${record.quarantineId}`;
    const value = serializeProfileRetryCorruptionQuarantine(record);
    const existing = current[name];
    if (existing === undefined) writes.push({ name, value });
    else if (!sameProfileRetryCorruptionQuarantine(existing, record)) {
      throw new Error("PROFILE_RETRY_QUARANTINE_CONFLICT:P1");
    }
  }
  assertProfileRetryQuarantineCapacity(current, writes);
  assertSafePropertyStoreWrites(current, writes, "PROFILE_RETRY_CORRUPTION_QUARANTINE");
  for (const write of writes) store.write(write.name, write.value);
  return [...unique.values()];
}

interface ParsedProfileRetryCandidate {
  item: ProfileRetryItem | null;
  reason?: string;
}

function parseProfileRetryCandidateValue(raw: string): ParsedProfileRetryCandidate {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { item: null, reason: "json" };
  }
  return parseProfileRetryCandidate(value, 0);
}

function parseProfileRetryCandidate(candidate: unknown, index: number): ParsedProfileRetryCandidate {
  try {
    const item = parseProfileRetryQueue(JSON.stringify([candidate]))[0]!;
    return { item };
  } catch (error) {
    const reason = error instanceof Error
      ? error.message.replace(/^INVALID_PROFILE_RETRY_QUEUE:/u, "").slice(0, 64)
      : `item_${index}`;
    return { item: null, reason: reason || `item_${index}` };
  }
}

function parseLegacyProfileRetryProperty(
  name: string,
  raw: string,
  ids: Set<string>,
  items: ProfileRetryItem[],
  sources: ProfileRetryPropertySource[],
  invalid: ProfileRetryPropertyIssue[],
): void {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    invalid.push(profileRetryPropertyIssue(name, raw, "legacy", "json"));
    return;
  }
  if (!Array.isArray(value)) {
    invalid.push(profileRetryPropertyIssue(name, raw, "legacy", "shape"));
    return;
  }
  if (value.length > MAX_PROFILE_RETRY_ITEMS) {
    throw new Error("PROFILE_RETRY_QUEUE_CAPACITY_EXCEEDED:P1");
  }

  const sourceItems: ProfileRetryItem[] = [];
  value.forEach((candidate, index) => {
    const parsed = parseProfileRetryCandidate(candidate, index);
    if (!parsed.item) {
      invalid.push(profileRetryPropertyIssue(name, raw, "legacy", parsed.reason ?? `item_${index}`, index));
      return;
    }
    const id = profileRetryItemId(parsed.item);
    if (ids.has(id)) {
      invalid.push(profileRetryPropertyIssue(name, raw, "legacy", "duplicate", index));
      return;
    }
    ids.add(id);
    items.push(parsed.item);
    sourceItems.push(parsed.item);
  });
  sources.push({ propertyName: name, sourceKind: "legacy", items: sourceItems });
}

function profileRetryPropertyIssue(
  propertyName: string,
  rawValue: string,
  sourceKind: ProfileRetryPropertyIssue["sourceKind"],
  rawReason: string,
  itemIndex?: number,
): ProfileRetryPropertyIssue {
  const reason = rawReason.replace(/[^A-Za-z0-9_:.-]/gu, "_").slice(0, 64) || "invalid";
  return {
    propertyName,
    sourceKind,
    reason,
    propertyHash: stableHash(propertyName),
    valueHash: stableHash(rawValue),
    valueBytes: utf8ByteLength(rawValue),
    ...(itemIndex === undefined ? {} : { itemIndex }),
  };
}

function profileRetryCorruptionQuarantineRecord(
  issue: ProfileRetryPropertyIssue,
  namespace: string,
  nowIso: string,
): ProfileRetryCorruptionQuarantineRecord {
  const material = {
    namespace,
    propertyHash: issue.propertyHash,
    valueHash: issue.valueHash,
    sourceKind: issue.sourceKind,
    reason: issue.reason,
    itemIndex: issue.itemIndex ?? null,
  };
  return {
    schemaVersion: 1,
    quarantineId: `q-${stableHash(material).slice(6)}-${stableHash({ material, valueBytes: issue.valueBytes }).slice(6)}`,
    sourceKind: issue.sourceKind,
    reason: issue.reason,
    propertyHash: issue.propertyHash,
    valueHash: issue.valueHash,
    valueBytes: issue.valueBytes,
    quarantinedAt: nowIso,
    ...(issue.itemIndex === undefined ? {} : { itemIndex: issue.itemIndex }),
  };
}

function serializeProfileRetryCorruptionQuarantine(record: ProfileRetryCorruptionQuarantineRecord): string {
  if (record.schemaVersion !== 1 ||
    !/^q-[0-9a-f]{8}-[0-9a-f]{8}$/u.test(record.quarantineId) ||
    !/^fnv1a-[0-9a-f]{8}$/u.test(record.propertyHash) ||
    !/^fnv1a-[0-9a-f]{8}$/u.test(record.valueHash) ||
    !["item", "legacy"].includes(record.sourceKind) ||
    !/^[A-Za-z0-9_:.-]{1,64}$/u.test(record.reason) ||
    !Number.isSafeInteger(record.valueBytes) || record.valueBytes < 0 ||
    !Number.isFinite(Date.parse(record.quarantinedAt)) ||
    (record.itemIndex !== undefined && (!Number.isSafeInteger(record.itemIndex) || record.itemIndex < 0))) {
    throw new Error("INVALID_PROFILE_RETRY_CORRUPTION_QUARANTINE");
  }
  const value = JSON.stringify(record);
  assertSafePropertyValue(value, "PROFILE_RETRY_CORRUPTION_QUARANTINE");
  return value;
}

function sameProfileRetryCorruptionQuarantine(
  raw: string,
  expected: ProfileRetryCorruptionQuarantineRecord,
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const existing = value as Partial<ProfileRetryCorruptionQuarantineRecord>;
  const allowed = [
    "itemIndex", "propertyHash", "quarantineId", "quarantinedAt", "reason", "schemaVersion",
    "sourceKind", "valueBytes", "valueHash",
  ];
  const actual = Object.keys(existing).sort();
  const expectedKeys = allowed.filter((key) => key !== "itemIndex" || expected.itemIndex !== undefined).sort();
  return actual.length === expectedKeys.length && actual.every((key, index) => key === expectedKeys[index]) &&
    existing.schemaVersion === expected.schemaVersion &&
    existing.quarantineId === expected.quarantineId &&
    existing.propertyHash === expected.propertyHash &&
    existing.valueHash === expected.valueHash &&
    existing.sourceKind === expected.sourceKind &&
    existing.reason === expected.reason &&
    existing.valueBytes === expected.valueBytes &&
    existing.itemIndex === expected.itemIndex &&
    typeof existing.quarantinedAt === "string" && Number.isFinite(Date.parse(existing.quarantinedAt));
}

export function assertProfileRetryQuarantineCapacity(
  current: Record<string, string>,
  writes: Array<{ name: string; value: string }>,
): void {
  const existing = Object.entries(current).filter(([name]) =>
    name.startsWith(PROFILE_RETRY_QUARANTINE_PROPERTY_PREFIX));
  if (existing.length + writes.length > PROFILE_RETRY_QUARANTINE_MAX_ITEMS) {
    throw new Error("PROFILE_RETRY_QUARANTINE_CAPACITY_EXCEEDED:P1");
  }
  const bytes = existing.reduce((total, [, value]) => total + utf8ByteLength(value), 0) +
    writes.reduce((total, write) => total + utf8ByteLength(write.value), 0);
  if (bytes > PROFILE_RETRY_QUARANTINE_MAX_VALUE_BYTES_TOTAL) {
    throw new Error("PROFILE_RETRY_QUARANTINE_CAPACITY_EXCEEDED:P1");
  }
}

function toProfileRetryPropertyStore(
  properties: ProfileRetryPropertyStore | GoogleAppsScript.Properties.Properties,
): ProfileRetryPropertyStore {
  if ("write" in properties && "remove" in properties) return properties;
  const native = properties as GoogleAppsScript.Properties.Properties;
  return {
    getProperties: () => native.getProperties(),
    write: native.setProperty.bind(native),
    remove: native.deleteProperty.bind(native),
  };
}

function sortProfileRetryItems(items: ProfileRetryItem[]): ProfileRetryItem[] {
  return [...items].sort((left, right) => {
    const dueOrder = (left.nextAttemptAt ?? left.queuedAt).localeCompare(right.nextAttemptAt ?? right.queuedAt);
    if (dueOrder !== 0) return dueOrder;
    const queueOrder = left.queuedAt.localeCompare(right.queuedAt);
    if (queueOrder !== 0) return queueOrder;
    return profileRetryItemId(left).localeCompare(profileRetryItemId(right));
  });
}

function assertProfileRetryCapacity(items: ProfileRetryItem[]): void {
  if (items.length > MAX_PROFILE_RETRY_ITEMS) throw new Error("PROFILE_RETRY_QUEUE_CAPACITY_EXCEEDED:P1");
  let totalBytes = 0;
  for (const item of items) {
    const value = JSON.stringify(item);
    assertSafePropertyValue(value, "PROFILE_RETRY_QUEUE");
    totalBytes += utf8ByteLength(value);
  }
  if (totalBytes > MAX_PROFILE_RETRY_VALUE_BYTES_TOTAL) {
    throw new Error("PROFILE_RETRY_QUEUE_CAPACITY_EXCEEDED:P1");
  }
}
