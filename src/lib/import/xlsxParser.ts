import ExcelJS from "exceljs";

/**
 * Native .xlsx reading — read-only usage of `exceljs` (actively maintained,
 * MIT-licensed, verified via `npm audit` to introduce zero new advisories
 * at the version pinned in package.json; its one transitive `uuid` finding
 * is patched via the `overrides` field there rather than accepted). Only
 * `Workbook.xlsx.load`/worksheet iteration are used — the write/streaming
 * APIs this package also exposes are never called, keeping the exposed
 * surface to exactly "parse an untrusted spreadsheet into strings."
 *
 * Converts a worksheet into the same string[][] shape src/lib/csv.ts's
 * hand-written CSV parser produces, so both formats share one column-
 * understanding pipeline downstream.
 *
 * STEP 1 spreadsheet-understanding (multiple worksheets, merged cells,
 * hidden columns) lives here because these are XLSX-specific concepts with
 * no CSV equivalent; src/lib/import/spreadsheetStructure.ts's table-bounds
 * detection (title/footer rows, blank leading rows) is the
 * format-agnostic half, applied identically to both formats downstream.
 */

export interface XlsxStructureMeta {
  /** Every worksheet name found in the workbook, in order. */
  sheetNames: string[];
  /** Which sheet was selected as the client table (most non-empty rows). */
  sheetUsed: string;
  /** True if the selected sheet has any merged cell ranges. */
  hadMergedCells: boolean;
  /** 0-based column indexes hidden in the source file, on the selected sheet. */
  hiddenColumnIndexes: number[];
}

export interface ParsedXlsxWorkbook {
  rows: string[][];
  meta: XlsxStructureMeta;
}

function worksheetToRows(worksheet: ExcelJS.Worksheet): string[][] {
  const rows: string[][] = [];
  worksheet.eachRow((row) => {
    // ExcelJS's `row.values` is 1-indexed (index 0 is always empty) and mixes
    // in rich-text/formula-result objects for non-plain cells — normalize
    // everything to a plain string the same way a CSV cell already is.
    // Merged cells are already resolved to the master cell's value by
    // ExcelJS itself at this point (verified: every cell in a merged range
    // reads the same value once the workbook has loaded), so a
    // row/column-spanning merge — e.g. one business-type label spanning
    // several client rows — is never lost, no extra handling needed here.
    const values = row.values as unknown[];
    const cells: string[] = [];
    for (let i = 1; i < values.length; i += 1) {
      cells.push(cellToString(values[i]));
    }
    rows.push(cells);
  });
  return rows;
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toLocaleDateString("he-IL");
  // Rich text (`{ richText: [...] }`) and formula results
  // (`{ formula, result }`) — both objects ExcelJS returns for non-plain
  // cells instead of a bare string.
  if (typeof value === "object") {
    const obj = value as { richText?: Array<{ text?: string }>; result?: unknown; text?: string };
    if (Array.isArray(obj.richText)) {
      return obj.richText.map((part) => part.text ?? "").join("").trim();
    }
    if ("result" in obj) return cellToString(obj.result);
    if (typeof obj.text === "string") return obj.text.trim();
  }
  return String(value).trim();
}

function countNonEmptyRows(rows: string[][]): number {
  return rows.filter((r) => r.some((c) => c.trim().length > 0)).length;
}

function detectHiddenColumns(worksheet: ExcelJS.Worksheet, columnCount: number): number[] {
  const hidden: number[] = [];
  for (let i = 1; i <= columnCount; i += 1) {
    if (worksheet.getColumn(i).hidden) hidden.push(i - 1); // report 0-based
  }
  return hidden;
}

// Reads the whole workbook, picks the worksheet most likely to hold the
// client table (most non-empty rows — a workbook with a "Sheet1" cover
// page and a "Clients" data sheet should never accidentally use the
// cover), and reports the structural facts STEP 1 requires: how many
// sheets exist, which one was used, whether merges or hidden columns were
// present. Hidden columns are reported, not excluded — a hidden column is
// still frequently real data an office just collapsed for display.
export async function parseXlsxWorkbook(buffer: ArrayBuffer | Buffer): Promise<ParsedXlsxWorkbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);

  const sheetNames = workbook.worksheets.map((ws) => ws.name);
  if (workbook.worksheets.length === 0) {
    return { rows: [], meta: { sheetNames: [], sheetUsed: "", hadMergedCells: false, hiddenColumnIndexes: [] } };
  }

  let bestSheet = workbook.worksheets[0];
  let bestRows = worksheetToRows(bestSheet);
  let bestScore = countNonEmptyRows(bestRows);

  for (const sheet of workbook.worksheets.slice(1)) {
    const rows = worksheetToRows(sheet);
    const score = countNonEmptyRows(rows);
    if (score > bestScore) {
      bestSheet = sheet;
      bestRows = rows;
      bestScore = score;
    }
  }

  const filteredRows = bestRows.filter((r) => r.some((c) => c.trim().length > 0));
  const columnCount = Math.max(0, ...bestRows.map((r) => r.length));

  return {
    rows: filteredRows,
    meta: {
      sheetNames,
      sheetUsed: bestSheet.name,
      hadMergedCells: (bestSheet.model.merges?.length ?? 0) > 0,
      hiddenColumnIndexes: detectHiddenColumns(bestSheet, columnCount),
    },
  };
}

// Backward-compatible, metadata-free entry point — used by callers (and
// existing tests) that only need the plain grid.
export async function parseXlsxToRows(buffer: ArrayBuffer | Buffer): Promise<string[][]> {
  const { rows } = await parseXlsxWorkbook(buffer);
  return rows;
}
