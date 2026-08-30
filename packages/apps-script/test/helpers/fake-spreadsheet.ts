export class FakeRange {
  constructor(
    private readonly sheet: FakeSheet,
    private readonly row: number,
    private readonly column: number,
    private readonly numRows: number,
    private readonly numColumns: number,
  ) {}

  getValues(): unknown[][] {
    return Array.from({ length: this.numRows }, (_, rowOffset) =>
      Array.from(
        { length: this.numColumns },
        (_, columnOffset) => this.sheet.cell(this.row + rowOffset, this.column + columnOffset),
      ),
    );
  }

  getFormulas(): string[][] {
    return this.getValues().map((row) => row.map((value) =>
      typeof value === "string" && value.startsWith("=") ? value : "",
    ));
  }

  setValues(values: unknown[][]): FakeRange {
    this.sheet.write(this.row, this.column, this.numRows, this.numColumns, values);
    return this;
  }

  setFormulaR1C1(formula: string): FakeRange {
    if (this.numRows !== 1 || this.numColumns !== 1) throw new Error("fake supports one R1C1 cell");
    this.sheet.writeFormulaR1C1(this.row, this.column, formula);
    return this;
  }
}

export class FakeSheet {
  readonly operations: string[] = [];
  readonly setValuesPayloads: unknown[][][] = [];
  failNextSetValues = false;
  private cells: unknown[][] = [];

  constructor(
    readonly name: string,
    private maxRows = 1000,
    private maxColumns = 26,
  ) {}

  seed(values: unknown[][]): void {
    this.cells = values.map((row) => [...row]);
  }

  matrix(): unknown[][] {
    const lastRow = this.getLastRow();
    const lastColumn = this.getLastColumn();
    return lastRow && lastColumn ? this.getRange(1, 1, lastRow, lastColumn).getValues() : [];
  }

  cell(row: number, column: number): unknown {
    return this.cells[row - 1]?.[column - 1] ?? "";
  }

  write(row: number, column: number, numRows: number, numColumns: number, values: unknown[][]): void {
    this.operations.push(`setValues:${row}:${column}:${numRows}:${numColumns}`);
    this.setValuesPayloads.push(values.map((valueRow) => [...valueRow]));
    if (this.failNextSetValues) {
      this.failNextSetValues = false;
      throw new Error("simulated write failure");
    }
    if (values.length !== numRows || values.some((valueRow) => valueRow.length !== numColumns)) {
      throw new Error("invalid matrix dimensions");
    }
    for (let rowOffset = 0; rowOffset < numRows; rowOffset += 1) {
      const targetRow = this.cells[row + rowOffset - 1] ?? [];
      this.cells[row + rowOffset - 1] = targetRow;
      for (let columnOffset = 0; columnOffset < numColumns; columnOffset += 1) {
        targetRow[column + columnOffset - 1] = values[rowOffset]?.[columnOffset] ?? "";
      }
    }
  }


  writeFormulaR1C1(row: number, column: number, formula: string): void {
    this.operations.push(`setFormulaR1C1:${row}:${column}:${formula}`);
    const targetRow = this.cells[row - 1] ?? [];
    this.cells[row - 1] = targetRow;
    targetRow[column - 1] = formula;
  }

  getMaxRows(): number { return this.maxRows; }
  getMaxColumns(): number { return this.maxColumns; }

  getLastRow(): number {
    for (let row = this.cells.length; row >= 1; row -= 1) {
      if (this.cells[row - 1]?.some((value) => value !== "" && value !== null && value !== undefined)) return row;
    }
    return 0;
  }

  getLastColumn(): number {
    let result = 0;
    for (const row of this.cells) {
      for (let column = row.length; column >= 1; column -= 1) {
        if (row[column - 1] !== "" && row[column - 1] !== null && row[column - 1] !== undefined) {
          result = Math.max(result, column);
          break;
        }
      }
    }
    return result;
  }

  insertRowsAfter(_afterPosition: number, howMany: number): void {
    this.operations.push(`insertRows:${howMany}`);
    this.maxRows += howMany;
  }

  insertColumnsAfter(_afterPosition: number, howMany: number): void {
    this.operations.push(`insertColumns:${howMany}`);
    this.maxColumns += howMany;
  }

  getRange(row: number, column: number, numRows: number, numColumns: number): FakeRange {
    if (row + numRows - 1 > this.maxRows || column + numColumns - 1 > this.maxColumns) {
      throw new Error("range exceeds grid");
    }
    return new FakeRange(this, row, column, numRows, numColumns);
  }

  getDataRange(): FakeRange {
    return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
  }

  clearContents(): FakeSheet {
    this.operations.push("clearContents");
    this.cells = [];
    return this;
  }

  setFrozenRows(rows: number): void {
    this.operations.push(`setFrozenRows:${rows}`);
  }
}

export class FakeSpreadsheet {
  readonly sheets = new Map<string, FakeSheet>();

  getSheetByName(name: string): FakeSheet | null {
    return this.sheets.get(name) ?? null;
  }

  insertSheet(name: string): FakeSheet {
    const sheet = new FakeSheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }
}
