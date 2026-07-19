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
 * Converts the first worksheet into the same string[][] shape
 * src/lib/csv.ts's hand-written CSV parser produces, so both formats share
 * one header-mapping implementation (mapRowsToClientRows) — adding a
 * format never means re-implementing "which column is the phone number."
 */
export async function parseXlsxToRows(buffer: ArrayBuffer | Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  const rows: string[][] = [];
  worksheet.eachRow((row) => {
    // ExcelJS's `row.values` is 1-indexed (index 0 is always empty) and mixes
    // in rich-text/formula-result objects for non-plain cells — normalize
    // everything to a plain string the same way a CSV cell already is.
    const values = row.values as unknown[];
    const cells: string[] = [];
    for (let i = 1; i < values.length; i += 1) {
      cells.push(cellToString(values[i]));
    }
    rows.push(cells);
  });

  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
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
