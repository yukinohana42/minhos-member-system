export interface SheetRangePort {
  getValues(): unknown[][];
  getFormulas?(): string[][];
  setValues(values: unknown[][]): SheetRangePort | void;
}

export interface SheetWritePort {
  getMaxRows(): number;
  getMaxColumns(): number;
  getLastRow(): number;
  getLastColumn(): number;
  insertRowsAfter(afterPosition: number, howMany: number): unknown;
  insertColumnsAfter(afterPosition: number, howMany: number): unknown;
  getRange(row: number, column: number, numRows: number, numColumns: number): SheetRangePort;
  clearContents(): unknown;
  setFrozenRows(rows: number): unknown;
}

export function ensureGridCapacity(sheet: SheetWritePort, requiredRows: number, requiredColumns: number): void {
  if (requiredRows > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), requiredRows - sheet.getMaxRows());
  }
  if (requiredColumns > sheet.getMaxColumns()) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredColumns - sheet.getMaxColumns());
  }
}

/**
 * Expand first, snapshot second, then replace. If the replacement write fails,
 * restore the previous cell contents before surfacing the original failure.
 */
export function safelyReplaceSheetContents(sheet: SheetWritePort, matrix: unknown[][]): void {
  const requiredRows = Math.max(1, matrix.length);
  const requiredColumns = Math.max(1, ...matrix.map((row) => row.length));
  ensureGridCapacity(sheet, requiredRows, requiredColumns);

  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  const snapshot = lastRow > 0 && lastColumn > 0
    ? snapshotContents(sheet.getRange(1, 1, lastRow, lastColumn))
    : [];

  try {
    sheet.clearContents();
    if (matrix.length > 0) sheet.getRange(1, 1, matrix.length, requiredColumns).setValues(matrix);
    sheet.setFrozenRows(1);
  } catch (writeError) {
    try {
      sheet.clearContents();
      if (snapshot.length > 0) {
        sheet.getRange(1, 1, snapshot.length, snapshot[0]?.length ?? 1).setValues(snapshot);
      }
    } catch {
      throw new Error("SHEET_WRITE_FAILED_AND_ROLLBACK_FAILED");
    }
    throw writeError;
  }
}

function snapshotContents(range: SheetRangePort): unknown[][] {
  const values = range.getValues();
  const formulas = range.getFormulas?.();
  if (!formulas) return values;
  return values.map((row, rowIndex) =>
    row.map((value, columnIndex) => formulas[rowIndex]?.[columnIndex] || value),
  );
}
