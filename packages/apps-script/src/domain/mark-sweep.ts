import type { SheetRecord } from "./types";

export interface MarkSweepResult<T extends SheetRecord> {
  records: T[];
  tombstoned: number;
}

export function markAndSweep<T extends SheetRecord>(input: {
  records: T[];
  keyColumn: keyof T & string;
  lastSeenColumn: keyof T & string;
  sourcePresentColumn: keyof T & string;
  sourceMissingSinceColumn: keyof T & string;
  completedFullScan: boolean;
  runId: string;
  nowIso: string;
}): MarkSweepResult<T> {
  if (!input.completedFullScan) return { records: input.records.map((row) => ({ ...row })), tombstoned: 0 };

  let tombstoned = 0;
  const records = input.records.map((row) => {
    if (row[input.lastSeenColumn] === input.runId || row[input.sourcePresentColumn] === false) return { ...row };
    tombstoned += 1;
    return {
      ...row,
      [input.sourcePresentColumn]: false,
      [input.sourceMissingSinceColumn]: row[input.sourceMissingSinceColumn] || input.nowIso,
    };
  });

  return { records, tombstoned };
}
