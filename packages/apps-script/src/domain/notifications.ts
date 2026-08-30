import type { ExceptionFinding, ExceptionRow } from "./types";

export interface NotificationDecision {
  exceptionKey: string;
  kind: "opened" | "changed" | "recovered";
  severity: string;
  summary: string;
}

export function planExceptionNotifications(input: {
  before: ExceptionRow[];
  after: ExceptionRow[];
  findings: ExceptionFinding[];
  now: Date;
}): NotificationDecision[] {
  const beforeByKey = new Map(input.before.map((row) => [row.exception_key, row]));
  const findingByKey = new Map(input.findings.map((finding) => [finding.exceptionKey, finding]));
  const decisions: NotificationDecision[] = [];

  for (const row of input.after) {
    const previous = beforeByKey.get(row.exception_key);
    if (isSuppressed(row, input.now)) continue;

    if (row.status === "resolved") {
      if (previous && previous.status !== "resolved" && previous.last_notified_at) {
        decisions.push({ exceptionKey: row.exception_key, kind: "recovered", severity: row.severity, summary: row.summary });
      }
      continue;
    }
    if (row.status === "ignored") continue;

    const finding = findingByKey.get(row.exception_key);
    const isImmediate = finding?.immediate === true;
    if (!previous && (isImmediate || row.occurrence_count >= 2)) {
      decisions.push({ exceptionKey: row.exception_key, kind: "opened", severity: row.severity, summary: row.summary });
      continue;
    }
    if (!previous) continue;
    if (previous.status === "resolved" || previous.severity !== row.severity || previous.summary !== row.summary) {
      decisions.push({ exceptionKey: row.exception_key, kind: "changed", severity: row.severity, summary: row.summary });
      continue;
    }
    if (!row.last_notified_at && (isImmediate || row.occurrence_count >= 2)) {
      decisions.push({ exceptionKey: row.exception_key, kind: "opened", severity: row.severity, summary: row.summary });
    }
  }

  return decisions;
}

export function markNotificationsSent(
  rows: ExceptionRow[],
  decisions: NotificationDecision[],
  nowIso: string,
): ExceptionRow[] {
  const keys = new Set(decisions.map(({ exceptionKey }) => exceptionKey));
  return rows.map((row) => (keys.has(row.exception_key) ? { ...row, last_notified_at: nowIso } : row));
}

export function notificationDeliveryBatch(
  decisions: NotificationDecision[],
  limit = 50,
): NotificationDecision[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("NOTIFICATION_BATCH_LIMIT_INVALID");
  return decisions.slice(0, limit);
}

function isSuppressed(row: ExceptionRow, now: Date): boolean {
  return Boolean(row.suppressed_until && Date.parse(row.suppressed_until) > now.getTime());
}
