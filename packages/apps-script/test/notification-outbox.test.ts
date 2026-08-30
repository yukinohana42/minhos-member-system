import { describe, expect, it } from "vitest";
import {
  completeNotificationOutboxItems,
  createNotificationOutboxQuarantineRecords,
  enqueueNotificationOutbox,
  markNotificationOutboxSent,
  NOTIFICATION_OUTBOX_QUARANTINE_PROPERTY_PREFIX,
  notificationOutboxPropertyName,
  notificationOutboxQuarantinePropertyName,
  parseNotificationOutbox,
  parseNotificationOutboxProperties,
  parseNotificationOutboxPropertiesTolerantly,
  planNotificationOutboxDelivery,
  repairNotificationOutboxProperties,
  serializeNotificationOutboxItem,
  sortNotificationOutboxItems,
} from "../src/domain/notification-outbox";
import { markNotificationsSent, type NotificationDecision } from "../src/domain/notifications";
import { SAFE_PROPERTY_VALUE_BYTES, utf8ByteLength } from "../src/domain/property-quota";
import type { ExceptionRow } from "../src/domain/types";

const firstIso = "2026-08-28T00:00:00.000Z";
const secondIso = "2026-08-28T01:00:00.000Z";

describe("durable notification outbox", () => {
  it("delivers more than 50 changes across batches without dropping the remainder", () => {
    let rows = Array.from({ length: 51 }, (_, index) => exceptionRow(index));
    const decisions = rows.map(notificationDecision);
    let outbox = enqueueNotificationOutbox([], decisions, firstIso);

    const first = planNotificationOutboxDelivery({ outbox, rows });
    expect(first.decisions).toHaveLength(50);
    outbox = markNotificationOutboxSent(outbox, first.deliverItems);
    rows = markNotificationsSent(rows, first.decisions, firstIso);
    outbox = completeNotificationOutboxItems(outbox, first.deliverItems);

    const second = planNotificationOutboxDelivery({ outbox, rows });
    expect(second.decisions).toHaveLength(1);
    const secondExceptionKey = second.deliverItems[0]!.exceptionKey;
    outbox = markNotificationOutboxSent(outbox, second.deliverItems);
    rows = markNotificationsSent(rows, second.decisions, secondIso);
    outbox = completeNotificationOutboxItems(outbox, second.deliverItems);

    expect(outbox).toEqual([]);
    expect(rows.filter((row) => row.last_notified_at)).toHaveLength(51);
    expect(rows.find((row) => row.exception_key === secondExceptionKey)?.last_notified_at).toBe(secondIso);
  });

  it("keeps the same pending items after a simulated mail failure and deduplicates re-enqueue", () => {
    const rows = [exceptionRow(1)];
    const decisions = rows.map(notificationDecision);
    const outbox = enqueueNotificationOutbox([], decisions, firstIso);
    const beforeFailure = planNotificationOutboxDelivery({ outbox, rows });

    expect(() => {
      throw new Error("MAIL_UNAVAILABLE");
    }).toThrow("MAIL_UNAVAILABLE");

    const retry = planNotificationOutboxDelivery({ outbox, rows });
    expect(retry).toEqual(beforeFailure);
    expect(enqueueNotificationOutbox(outbox, decisions, secondIso)).toEqual(outbox);
  });

  it("persists only minimal routing metadata and validates every queued item", () => {
    const decision: NotificationDecision = {
      exceptionKey: "PROFILE_SUBMISSION_UNMATCHED:response_1",
      kind: "opened",
      severity: "P2",
      summary: "member@example.invalid の回答本文 secret-value",
    };
    const outbox = enqueueNotificationOutbox([], [decision], firstIso);
    const encoded = JSON.stringify(outbox);
    expect(encoded).not.toContain("member@example.invalid");
    expect(encoded).not.toContain("secret-value");
    expect(parseNotificationOutbox(encoded)).toEqual(outbox);
    expect(() => parseNotificationOutbox(encoded.replace('"pending"', '"unknown"')))
      .toThrow("INVALID_NOTIFICATION_OUTBOX");
  });

  it("stores a burst as quota-safe item properties instead of one oversized value", () => {
    const rows = Array.from({ length: 200 }, (_, index) => exceptionRow(index));
    const outbox = enqueueNotificationOutbox([], rows.map(notificationDecision), firstIso);
    const fingerprint = "context";
    const properties = Object.fromEntries(outbox.map((item) => [
      notificationOutboxPropertyName(item.notificationId, fingerprint),
      serializeNotificationOutboxItem(item),
    ]));

    expect(Object.keys(properties)).toHaveLength(200);
    expect(Math.max(...Object.values(properties).map(utf8ByteLength))).toBeLessThanOrEqual(SAFE_PROPERTY_VALUE_BYTES);
    expect(parseNotificationOutboxProperties(properties, fingerprint)).toEqual(expect.arrayContaining(outbox));
  });

  it("turns an orphaned item into a generic alert without poisoning later items", () => {
    const rows = [exceptionRow(2)];
    const outbox = enqueueNotificationOutbox([], [
      { exceptionKey: "ORPHAN:1", kind: "opened", severity: "P1", summary: "not persisted" },
      notificationDecision(rows[0]!),
    ], firstIso);
    const plan = planNotificationOutboxDelivery({ outbox, rows });
    expect(plan.decisions).toHaveLength(2);
    expect(plan.decisions[0]).toMatchObject({ exceptionKey: "ORPHAN:1", severity: "P1" });
    expect(plan.decisions[0]?.summary).toContain("例外台帳行");
    expect(plan.decisions[1]?.exceptionKey).toBe("EXCEPTION:2");
  });

  it("delivers causal transitions by enqueue time, kind, and stable ID instead of property hash order", () => {
    const base = enqueueNotificationOutbox([], [notificationDecision(exceptionRow(20))], firstIso)[0]!;
    const items = [
      { ...base, notificationId: "n-ffffffff-ffffffff", kind: "recovered" as const },
      { ...base, notificationId: "n-bbbbbbbb-bbbbbbbb", kind: "changed" as const },
      { ...base, notificationId: "n-aaaaaaaa-aaaaaaaa", kind: "opened" as const },
      {
        ...base,
        notificationId: "n-00000000-00000000",
        kind: "recovered" as const,
        enqueuedAt: "2026-08-27T23:59:59.000Z",
      },
    ];

    expect(sortNotificationOutboxItems(items).map((item) => item.notificationId)).toEqual([
      "n-00000000-00000000",
      "n-aaaaaaaa-aaaaaaaa",
      "n-bbbbbbbb-bbbbbbbb",
      "n-ffffffff-ffffffff",
    ]);
    expect(planNotificationOutboxDelivery({ outbox: items, rows: [exceptionRow(20)] })
      .deliverItems.map((item) => item.kind)).toEqual([
      "recovered", "opened", "changed", "recovered",
    ]);
  });

  it("quarantines malformed item and legacy properties while retaining valid siblings", () => {
    const context = "context";
    const validItem = enqueueNotificationOutbox([], [notificationDecision(exceptionRow(10))], firstIso)[0]!;
    const legacySibling = enqueueNotificationOutbox([], [notificationDecision(exceptionRow(11))], firstIso)[0]!;
    const malformedJsonName = `${"NOTIFICATION_OUTBOX_JSON:"}broken-json:${context}`;
    const malformedShapeName = `${"NOTIFICATION_OUTBOX_JSON:"}broken-shape:${context}`;
    const malformedKeyName = `${"NOTIFICATION_OUTBOX_JSON:"}wrong-key:${context}`;
    const legacyName = `${"NOTIFICATION_OUTBOX_JSON:"}${context}`;
    const store = propertyStore({
      [notificationOutboxPropertyName(validItem.notificationId, context)]: serializeNotificationOutboxItem(validItem),
      [malformedJsonName]: '{"opaque":"member-at-example.invalid"',
      [malformedShapeName]: "[]",
      [malformedKeyName]: serializeNotificationOutboxItem(validItem),
      [legacyName]: JSON.stringify([legacySibling, { malformed: "no-raw-value-token" }]),
    });

    const repaired = repairNotificationOutboxProperties(store, context, firstIso);

    expect(repaired.map((item) => item.notificationId)).toEqual(expect.arrayContaining([
      validItem.notificationId,
      legacySibling.notificationId,
    ]));
    expect(store.values.has(malformedJsonName)).toBe(false);
    expect(store.values.has(malformedShapeName)).toBe(false);
    expect(store.values.has(malformedKeyName)).toBe(false);
    expect(store.values.has(legacyName)).toBe(false);
    const quarantineValues = [...store.values.entries()]
      .filter(([name]) => name.startsWith(NOTIFICATION_OUTBOX_QUARANTINE_PROPERTY_PREFIX))
      .map(([, value]) => value);
    expect(quarantineValues.length).toBe(4);
    expect(quarantineValues.join("\n")).not.toContain("member-at-example.invalid");
    expect(quarantineValues.join("\n")).not.toContain("no-raw-value-token");
    expect(planNotificationOutboxDelivery({
      outbox: repaired,
      rows: [exceptionRow(10), exceptionRow(11)],
    }).decisions).toHaveLength(2);
  });

  it("isolates duplicate legacy candidates and continues with the first occurrence", () => {
    const context = "context";
    const first = enqueueNotificationOutbox([], [notificationDecision(exceptionRow(12))], firstIso)[0]!;
    const sibling = enqueueNotificationOutbox([], [notificationDecision(exceptionRow(13))], firstIso)[0]!;
    const legacyName = `${"NOTIFICATION_OUTBOX_JSON:"}${context}`;
    const store = propertyStore({
      [legacyName]: JSON.stringify([first, first, sibling]),
    });

    const parsed = parseNotificationOutboxPropertiesTolerantly(store.getProperties(), context);
    expect(parsed.items.map((item) => item.notificationId)).toEqual([first.notificationId, sibling.notificationId]);
    expect(parsed.invalid).toHaveLength(1);
    expect(parsed.invalid[0]).toMatchObject({ sourceKind: "legacy", reason: "duplicate", itemIndex: 1 });

    const repaired = repairNotificationOutboxProperties(store, context, firstIso);
    expect(repaired).toHaveLength(2);
    expect(store.values.has(legacyName)).toBe(false);
    expect([...store.values.keys()].filter((name) => name.startsWith(NOTIFICATION_OUTBOX_QUARANTINE_PROPERTY_PREFIX))).toHaveLength(1);
  });

  it("is idempotent when the same corrupt source is replayed after quarantine", () => {
    const context = "context";
    const sourceName = `${"NOTIFICATION_OUTBOX_JSON:"}broken:${context}`;
    const store = propertyStore({ [sourceName]: "not-json" });

    repairNotificationOutboxProperties(store, context, firstIso);
    const afterFirst = new Map(store.values);
    repairNotificationOutboxProperties(store, context, firstIso);

    expect(store.values).toEqual(afterFirst);
    expect([...store.values.keys()].filter((name) => name.startsWith(NOTIFICATION_OUTBOX_QUARANTINE_PROPERTY_PREFIX))).toHaveLength(1);
    const issue = parseNotificationOutboxPropertiesTolerantly({ [sourceName]: "not-json" }, context).invalid[0]!;
    expect(createNotificationOutboxQuarantineRecords([issue], context, firstIso))
      .toEqual(createNotificationOutboxQuarantineRecords([issue], context, firstIso));
  });

  it("rejects an existing quarantine record with any extra raw field and keeps the source", () => {
    const context = "context";
    const sourceName = `${"NOTIFICATION_OUTBOX_JSON:"}broken-extra:${context}`;
    const issue = parseNotificationOutboxPropertiesTolerantly({ [sourceName]: "raw-sensitive" }, context).invalid[0]!;
    const record = createNotificationOutboxQuarantineRecords([issue], context, firstIso)[0]!;
    const quarantineName = notificationOutboxQuarantinePropertyName(record, context);
    const store = propertyStore({
      [sourceName]: "raw-sensitive",
      [quarantineName]: JSON.stringify({ ...record, rawValue: "raw-sensitive" }),
    });

    expect(() => repairNotificationOutboxProperties(store, context, secondIso))
      .toThrow("NOTIFICATION_OUTBOX_QUARANTINE_CONFLICT:P1");
    expect(store.values.has(sourceName)).toBe(true);
    expect(store.removals).toEqual([]);
  });

  it("replays a persisted quarantine after source deletion fails without duplicating metadata", () => {
    const context = "context";
    const sourceName = `${"NOTIFICATION_OUTBOX_JSON:"}broken:${context}`;
    const store = propertyStore({ [sourceName]: "not-json" });
    let failDelete = true;
    const originalRemove = store.remove;
    store.remove = (name: string) => {
      if (failDelete) {
        failDelete = false;
        throw new Error("SOURCE_DELETE_FAILED");
      }
      return originalRemove(name);
    };

    expect(() => repairNotificationOutboxProperties(store, context, firstIso)).toThrow("SOURCE_DELETE_FAILED");
    expect(store.values.has(sourceName)).toBe(true);
    const quarantineCount = [...store.values.keys()]
      .filter((name) => name.startsWith(NOTIFICATION_OUTBOX_QUARANTINE_PROPERTY_PREFIX)).length;
    expect(quarantineCount).toBe(1);

    expect(() => repairNotificationOutboxProperties(store, context, secondIso)).not.toThrow();
    expect(store.values.has(sourceName)).toBe(false);
    expect([...store.values.keys()]
      .filter((name) => name.startsWith(NOTIFICATION_OUTBOX_QUARANTINE_PROPERTY_PREFIX))).toHaveLength(1);
  });

  it("fails closed on quarantine write failure and leaves every source intact", () => {
    const context = "context";
    const sourceName = `${"NOTIFICATION_OUTBOX_JSON:"}broken:${context}`;
    const sibling = enqueueNotificationOutbox([], [notificationDecision(exceptionRow(14))], firstIso)[0]!;
    const siblingName = notificationOutboxPropertyName(sibling.notificationId, context);
    const store = propertyStore({
      [sourceName]: "not-json",
      [siblingName]: serializeNotificationOutboxItem(sibling),
    });
    const originalWrite = store.write;
    store.write = (name, value) => {
      if (name.startsWith(NOTIFICATION_OUTBOX_QUARANTINE_PROPERTY_PREFIX)) throw new Error("QUARANTINE_WRITE_FAILED");
      return originalWrite(name, value);
    };

    expect(() => repairNotificationOutboxProperties(store, context, firstIso)).toThrow("QUARANTINE_WRITE_FAILED");
    expect(store.values.has(sourceName)).toBe(true);
    expect(store.values.has(siblingName)).toBe(true);
    expect([...store.values.keys()].filter((name) => name.startsWith(NOTIFICATION_OUTBOX_QUARANTINE_PROPERTY_PREFIX))).toHaveLength(0);
  });

  it("fails closed before deleting corrupt sources when quarantine capacity is exhausted", () => {
    const context = "context";
    const properties = Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [
      `${"NOTIFICATION_OUTBOX_JSON:"}broken-${index}:${context}`,
      "not-json",
    ]));
    const store = propertyStore(properties);

    expect(() => repairNotificationOutboxProperties(store, context, firstIso))
      .toThrow("NOTIFICATION_OUTBOX_QUARANTINE_CAPACITY_EXCEEDED:P1");
    expect(store.values.size).toBe(1_001);
  });
});

function propertyStore(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  const writes: Array<[string, string]> = [];
  const removals: string[] = [];
  return {
    values,
    writes,
    removals,
    getProperties: () => Object.fromEntries(values),
    write: (name: string, value: string) => {
      writes.push([name, value]);
      values.set(name, value);
    },
    remove: (name: string) => {
      removals.push(name);
      values.delete(name);
    },
  };
}

function exceptionRow(index: number): ExceptionRow {
  return {
    exception_key: `EXCEPTION:${index}`,
    exception_id: `ex_${index}`,
    exception_type: "TEST_EXCEPTION",
    severity: "P2",
    summary: `summary ${index}`,
    minhos_member_id: "",
    ghost_member_id: "",
    stripe_customer_id: "",
    stripe_subscription_id: "",
    signal_key: "",
    first_detected_at: firstIso,
    last_detected_at: firstIso,
    occurrence_count: 1,
    status: "open",
    assignee: "",
    resolution: "",
    resolved_at: "",
    suppressed_until: "",
    last_notified_at: "",
    related_sync_run_id: "run",
  };
}

function notificationDecision(row: ExceptionRow): NotificationDecision {
  return {
    exceptionKey: row.exception_key,
    kind: "changed",
    severity: row.severity,
    summary: row.summary,
  };
}
