import { mapRowsToClientRows, parseCsv, type CsvClientRow } from "@/lib/csv";
import { parseXlsxToRows, parseXlsxWorkbook, type XlsxStructureMeta } from "@/lib/import/xlsxParser";
import { extractTable, type TableBounds } from "@/lib/import/spreadsheetStructure";

/**
 * Single entry point the onboarding wizard's "Import Excel / CSV" step (and
 * any future importer) calls. Both formats funnel through the same
 * mapRowsToClientRows() header-alias mapping (src/lib/csv.ts), so adding a
 * third format later means writing one more `parseXToRows` function, never
 * touching column-detection logic twice.
 *
 * .xlsx is natively supported (src/lib/import/xlsxParser.ts, via the
 * actively-maintained `exceljs` package — see that file's header comment
 * for the security rationale). Legacy binary .xls (pre-2007 format,
 * structurally unrelated to .xlsx/OOXML) is not supported — no
 * comparably safe, actively-maintained parser exists for it, and Excel
 * itself defaults to .xlsx for anything saved today, so it's rejected with
 * a message pointing at either supported format rather than a raw parse
 * error.
 */

export class UnsupportedImportFormatError extends Error {}

function extensionOf(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex + 1).toLowerCase() : "";
}

// The one place format dispatch happens — both CSV and XLSX produce the
// exact same string[][] grid, so every consumer (the header-alias-only
// mapRowsToClientRows() below, and src/lib/import/columnAnalyzer.ts's
// content-based inference used by the wizard) implements column
// understanding exactly once, for both formats.
export async function parseClientImportFileToGrid(file: File): Promise<string[][]> {
  const extension = extensionOf(file.name);

  if (extension === "csv") {
    const text = await file.text();
    return parseCsv(text);
  }

  if (extension === "xlsx") {
    const buffer = await file.arrayBuffer();
    try {
      return await parseXlsxToRows(buffer);
    } catch {
      throw new UnsupportedImportFormatError(
        "לא ניתן היה לקרוא את קובץ ה-Excel. ודאו שהקובץ תקין ואינו פגום, או ייצאו אותו כ-CSV ונסו שוב."
      );
    }
  }

  if (extension === "xls") {
    throw new UnsupportedImportFormatError(
      "קובצי Excel ישנים (.xls) אינם נתמכים. נא לשמור את הקובץ כ-.xlsx (Excel נוכחי) או כ-CSV ולהעלות אותו מחדש."
    );
  }

  throw new UnsupportedImportFormatError(
    "סוג קובץ לא נתמך. נא להעלות קובץ Excel (.xlsx) או CSV."
  );
}

// Best-effort, no-confirmation-step convenience wrapper — kept for callers
// (and tests) that just want the mapped rows directly. The wizard's real
// import flow (src/app/onboarding/actions.ts) calls
// analyzeImportFileStructure() below instead, so it can show a
// mapping-confirmation screen when confidence is low rather than throwing.
export async function parseClientImportFile(file: File): Promise<CsvClientRow[]> {
  const rows = await parseClientImportFileToGrid(file);
  return mapRowsToClientRows(rows);
}

export interface ImportFileStructure {
  /** Just the real table — title/footer/blank rows already trimmed off. */
  rows: string[][];
  tableBounds: TableBounds;
  /** Present for .xlsx only — which sheet was used, merges, hidden columns. */
  xlsxMeta?: XlsxStructureMeta;
}

// STEP 1 ("spreadsheet understanding") entry point — the real wizard
// import flow. Parses the file, resolves XLSX-specific structure (which of
// possibly several worksheets holds the client table; ExcelJS already
// resolves merged-cell values transparently on load, verified directly —
// see xlsxParser.ts), then applies the format-agnostic table-boundary
// detection (spreadsheetStructure.ts) so title rows, blank spacer rows, and
// trailing summary rows never reach column analysis. Both formats return
// the exact same shape from here on.
export async function analyzeImportFileStructure(file: File): Promise<ImportFileStructure> {
  const extension = extensionOf(file.name);

  if (extension === "csv") {
    const text = await file.text();
    const { table, bounds } = extractTable(parseCsv(text));
    return { rows: table, tableBounds: bounds };
  }

  if (extension === "xlsx") {
    const buffer = await file.arrayBuffer();
    let parsed: Awaited<ReturnType<typeof parseXlsxWorkbook>>;
    try {
      parsed = await parseXlsxWorkbook(buffer);
    } catch {
      throw new UnsupportedImportFormatError(
        "לא ניתן היה לקרוא את קובץ ה-Excel. ודאו שהקובץ תקין ואינו פגום, או ייצאו אותו כ-CSV ונסו שוב."
      );
    }
    const { table, bounds } = extractTable(parsed.rows);
    return { rows: table, tableBounds: bounds, xlsxMeta: parsed.meta };
  }

  if (extension === "xls") {
    throw new UnsupportedImportFormatError(
      "קובצי Excel ישנים (.xls) אינם נתמכים. נא לשמור את הקובץ כ-.xlsx (Excel נוכחי) או כ-CSV ולהעלות אותו מחדש."
    );
  }

  throw new UnsupportedImportFormatError(
    "סוג קובץ לא נתמך. נא להעלות קובץ Excel (.xlsx) או CSV."
  );
}
