import { mapRowsToClientRows, parseCsv, type CsvClientRow } from "@/lib/csv";
import { parseXlsxToRows } from "@/lib/import/xlsxParser";

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
// parseClientImportFileToGrid + src/lib/import/columnAnalyzer.ts directly
// instead, so it can show a mapping-confirmation screen when confidence is
// low rather than throwing.
export async function parseClientImportFile(file: File): Promise<CsvClientRow[]> {
  const rows = await parseClientImportFileToGrid(file);
  return mapRowsToClientRows(rows);
}
