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

export async function parseClientImportFile(file: File): Promise<CsvClientRow[]> {
  const extension = extensionOf(file.name);

  if (extension === "csv") {
    const text = await file.text();
    return mapRowsToClientRows(parseCsv(text));
  }

  if (extension === "xlsx") {
    const buffer = await file.arrayBuffer();
    let rows: string[][];
    try {
      rows = await parseXlsxToRows(buffer);
    } catch {
      throw new UnsupportedImportFormatError(
        "לא ניתן היה לקרוא את קובץ ה-Excel. ודאו שהקובץ תקין ואינו פגום, או ייצאו אותו כ-CSV ונסו שוב."
      );
    }
    return mapRowsToClientRows(rows);
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
