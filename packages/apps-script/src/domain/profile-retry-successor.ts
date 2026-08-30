import { assertSafePropertyStoreWrites, assertSafePropertyValue, utf8ByteLength } from "./property-quota";
import type { ManagedTriggerSpec, TriggerDescriptor } from "./trigger-integrity";
import { stableHash } from "./values";

export const PROFILE_RETRY_SUCCESSOR_PROPERTY_PREFIX = "PROFILE_FORM_RETRY_SUCCESSOR_UID:";
export const PROFILE_RETRY_SUCCESSOR_QUARANTINE_PROPERTY_PREFIX =
  "PROFILE_FORM_RETRY_SUCCESSOR_QUARANTINE_JSON:";

const MAX_SUCCESSOR_UID_LENGTH = 256;
const MAX_SUCCESSOR_QUARANTINE_ITEMS = 100;
const MAX_SUCCESSOR_QUARANTINE_VALUE_BYTES = 32 * 1024;

export interface ProfileRetrySuccessorPropertyStore {
  getProperties(): Record<string, string>;
  write(name: string, value: string): unknown;
  remove(name: string): unknown;
}

export interface ProfileRetrySuccessorQuarantineRecord {
  schemaVersion: 1;
  quarantineId: string;
  propertyHash: string;
  valueHash: string;
  valueBytes: number;
  reason: "invalid_uid";
  quarantinedAt: string;
}

export type ProfileRetrySuccessorPlan =
  | { action: "none" }
  | { action: "keep"; uniqueId: string }
  | { action: "clear" }
  | { action: "delete_and_clear"; uniqueId: string }
  | { action: "create" };

export function profileRetrySuccessorPropertyName(namespace: string): string {
  if (!namespace) throw new Error("PROFILE_RETRY_SUCCESSOR_NAMESPACE_REQUIRED");
  return `${PROFILE_RETRY_SUCCESSOR_PROPERTY_PREFIX}${namespace}`;
}

export function parseProfileRetrySuccessorUid(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" || raw.length < 1 || raw.length > MAX_SUCCESSOR_UID_LENGTH ||
    raw !== raw.trim() || /[\u0000-\u001f\u007f\s]/u.test(raw)) {
    throw new Error("INVALID_PROFILE_RETRY_SUCCESSOR_UID");
  }
  return raw;
}

/**
 * A malformed marker must not permanently orphan a durable retry queue. Store
 * only hashes of the property and value, then remove the corrupt source. The
 * quarantine write is durable before deletion and idempotent on replay.
 */
export function repairProfileRetrySuccessorUid(
  properties: ProfileRetrySuccessorPropertyStore | GoogleAppsScript.Properties.Properties,
  namespace: string,
  quarantinedAt: string,
): string | null {
  if (!Number.isFinite(Date.parse(quarantinedAt))) {
    throw new Error("INVALID_PROFILE_RETRY_SUCCESSOR_QUARANTINE_AT");
  }
  const store = toSuccessorPropertyStore(properties);
  const sourceName = profileRetrySuccessorPropertyName(namespace);
  const snapshot = store.getProperties();
  const raw = snapshot[sourceName];
  try {
    return parseProfileRetrySuccessorUid(raw);
  } catch {
    const record = successorQuarantineRecord(sourceName, raw ?? "", quarantinedAt);
    persistSuccessorQuarantine(store, record, namespace);
    store.remove(sourceName);
    return null;
  }
}

export function persistProfileRetrySuccessorUid(
  properties: ProfileRetrySuccessorPropertyStore | GoogleAppsScript.Properties.Properties,
  namespace: string,
  uniqueId: string,
): void {
  const store = toSuccessorPropertyStore(properties);
  const value = parseProfileRetrySuccessorUid(uniqueId);
  if (!value) throw new Error("PROFILE_RETRY_SUCCESSOR_UID_REQUIRED");
  const name = profileRetrySuccessorPropertyName(namespace);
  const current = store.getProperties();
  assertSafePropertyValue(value, "PROFILE_RETRY_SUCCESSOR");
  assertSafePropertyStoreWrites(current, [{ name, value }], "PROFILE_RETRY_SUCCESSOR");
  store.write(name, value);
  if (store.getProperties()[name] !== value) {
    throw new Error("PROFILE_RETRY_SUCCESSOR_WRITE_NOT_DURABLE");
  }
}

export function clearProfileRetrySuccessorUid(
  properties: ProfileRetrySuccessorPropertyStore | GoogleAppsScript.Properties.Properties,
  namespace: string,
): void {
  toSuccessorPropertyStore(properties).remove(profileRetrySuccessorPropertyName(namespace));
}

/**
 * Only the UID stored in the marker is a future successor. An unmarked exact
 * trigger may be another execution which is already running, so it must never
 * suppress creation of the next one-shot trigger.
 */
export function planProfileRetrySuccessor(input: {
  queuePresent: boolean;
  successorUid: string | null;
  executingTriggerUid?: string;
  triggers: readonly TriggerDescriptor[];
  constraint: ManagedTriggerSpec;
}): ProfileRetrySuccessorPlan {
  const liveMarkedTrigger = input.successorUid === null
    ? undefined
    : input.triggers.find((trigger) =>
      trigger.uniqueId === input.successorUid && triggerMatches(trigger, input.constraint));

  if (!input.queuePresent) {
    if (input.successorUid === null) return { action: "none" };
    if (input.successorUid !== input.executingTriggerUid && liveMarkedTrigger) {
      return { action: "delete_and_clear", uniqueId: input.successorUid };
    }
    return { action: "clear" };
  }

  if (input.successorUid !== null &&
    input.successorUid !== input.executingTriggerUid &&
    liveMarkedTrigger) {
    return { action: "keep", uniqueId: input.successorUid };
  }
  return { action: "create" };
}

function triggerMatches(trigger: TriggerDescriptor, constraint: ManagedTriggerSpec): boolean {
  return trigger.handlerFunction === constraint.handlerFunction &&
    trigger.eventType === constraint.eventType &&
    trigger.triggerSource === constraint.triggerSource &&
    trigger.triggerSourceId === constraint.triggerSourceId;
}

function successorQuarantineRecord(
  propertyName: string,
  rawValue: string,
  quarantinedAt: string,
): ProfileRetrySuccessorQuarantineRecord {
  const propertyHash = stableHash(propertyName);
  const valueHash = stableHash(rawValue);
  const material = { propertyHash, valueHash, reason: "invalid_uid" };
  return {
    schemaVersion: 1,
    quarantineId: `q-${stableHash(material).slice(6)}-${stableHash({ material }).slice(6)}`,
    propertyHash,
    valueHash,
    valueBytes: utf8ByteLength(rawValue),
    reason: "invalid_uid",
    quarantinedAt,
  };
}

function persistSuccessorQuarantine(
  store: ProfileRetrySuccessorPropertyStore,
  record: ProfileRetrySuccessorQuarantineRecord,
  namespace: string,
): void {
  const name = `${PROFILE_RETRY_SUCCESSOR_QUARANTINE_PROPERTY_PREFIX}${namespace}:${record.quarantineId}`;
  const value = serializeSuccessorQuarantine(record);
  const current = store.getProperties();
  const existing = current[name];
  if (existing !== undefined) {
    if (!sameSuccessorQuarantine(existing, record)) {
      throw new Error("PROFILE_RETRY_SUCCESSOR_QUARANTINE_CONFLICT:P1");
    }
    return;
  }
  const quarantineEntries = Object.entries(current).filter(([propertyName]) =>
    propertyName.startsWith(PROFILE_RETRY_SUCCESSOR_QUARANTINE_PROPERTY_PREFIX));
  const quarantineBytes = quarantineEntries.reduce(
    (total, [, candidate]) => total + utf8ByteLength(candidate),
    utf8ByteLength(value),
  );
  if (quarantineEntries.length + 1 > MAX_SUCCESSOR_QUARANTINE_ITEMS ||
    quarantineBytes > MAX_SUCCESSOR_QUARANTINE_VALUE_BYTES) {
    throw new Error("PROFILE_RETRY_SUCCESSOR_QUARANTINE_CAPACITY_EXCEEDED:P1");
  }
  assertSafePropertyStoreWrites(current, [{ name, value }], "PROFILE_RETRY_SUCCESSOR_QUARANTINE");
  store.write(name, value);
  if (store.getProperties()[name] !== value) {
    throw new Error("PROFILE_RETRY_SUCCESSOR_QUARANTINE_WRITE_NOT_DURABLE");
  }
}

function serializeSuccessorQuarantine(record: ProfileRetrySuccessorQuarantineRecord): string {
  if (record.schemaVersion !== 1 ||
    !/^q-[0-9a-f]{8}-[0-9a-f]{8}$/u.test(record.quarantineId) ||
    !/^fnv1a-[0-9a-f]{8}$/u.test(record.propertyHash) ||
    !/^fnv1a-[0-9a-f]{8}$/u.test(record.valueHash) ||
    !Number.isSafeInteger(record.valueBytes) || record.valueBytes < 0 ||
    record.reason !== "invalid_uid" ||
    !Number.isFinite(Date.parse(record.quarantinedAt))) {
    throw new Error("INVALID_PROFILE_RETRY_SUCCESSOR_QUARANTINE");
  }
  const value = JSON.stringify(record);
  assertSafePropertyValue(value, "PROFILE_RETRY_SUCCESSOR_QUARANTINE");
  return value;
}

function sameSuccessorQuarantine(
  raw: string,
  expected: ProfileRetrySuccessorQuarantineRecord,
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const existing = value as Partial<ProfileRetrySuccessorQuarantineRecord>;
  const keys = [
    "propertyHash", "quarantineId", "quarantinedAt", "reason", "schemaVersion", "valueBytes", "valueHash",
  ];
  const actualKeys = Object.keys(existing).sort();
  return actualKeys.length === keys.length &&
    actualKeys.every((key, index) => key === keys[index]) &&
    existing.schemaVersion === expected.schemaVersion &&
    existing.quarantineId === expected.quarantineId &&
    existing.propertyHash === expected.propertyHash &&
    existing.valueHash === expected.valueHash &&
    existing.valueBytes === expected.valueBytes &&
    existing.reason === expected.reason &&
    typeof existing.quarantinedAt === "string" && Number.isFinite(Date.parse(existing.quarantinedAt));
}

function toSuccessorPropertyStore(
  properties: ProfileRetrySuccessorPropertyStore | GoogleAppsScript.Properties.Properties,
): ProfileRetrySuccessorPropertyStore {
  if ("write" in properties && "remove" in properties) return properties;
  const native = properties as GoogleAppsScript.Properties.Properties;
  return {
    getProperties: () => native.getProperties(),
    write: native.setProperty.bind(native),
    remove: native.deleteProperty.bind(native),
  };
}
