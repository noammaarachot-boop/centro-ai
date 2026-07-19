import { parseClientCsv, type CsvClientRow } from "@/lib/csv";

/**
 * Single entry point the onboarding wizard's "Import Excel / CSV" step (and
 * any future importer) calls — the one file a future native .xlsx/.xls
 * parser swap touches, without the wizard or its actions ever needing to
 * change. See Epic 3 planning notes: the project deliberately shipped
 * CSV-only in M4 because the only npm .xlsx parser (xlsx/SheetJS) carries
 * unpatched high-severity vulnerabilities on the public registry. Excel
 * files are recognized (so the user gets a clear, friendly message) but not
 * parsed — CSV is the fully real path today.
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
    return parseClientCsv(text);
  }

  if (extension === "xlsx" || extension === "xls") {
    throw new UnsupportedImportFormatError(
      "קובצי Excel (.xlsx/.xls) עדיין לא נתמכים ישירות. נא לייצא את הגיליון כ-CSV מתוך Excel (קובץ ← שמירה בשם ← CSV) ולהעלות את קובץ ה-CSV."
    );
  }

  throw new UnsupportedImportFormatError(
    "סוג קובץ לא נתמך. נא להעלות קובץ CSV או Excel (.xlsx/.xls)."
  );
}
