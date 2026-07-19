/**
 * STEP 1 of the Smart Import Engine — spreadsheet understanding.
 *
 * Before any column is scored for name/phone/email/etc. (columnAnalyzer.ts,
 * STEP 2), the importer first has to find the actual data table inside the
 * sheet. Real office files routinely have a title row above the table
 * ("רשימת לקוחות — משרד כהן ושות'"), a blank spacer row, or a trailing
 * summary/footer row below the last real client ("סה\"כ: 83 לקוחות") — none
 * of which are client rows, and feeding them into column analysis would
 * corrupt every score (a lone wide title cell looks like nothing; a footer
 * row looks like a malformed, mostly-empty data row).
 *
 * This is format-agnostic — it operates on the plain string[][] grid either
 * parser (src/lib/csv.ts, src/lib/import/xlsxParser.ts) already produces,
 * so table-boundary understanding is implemented exactly once for both
 * formats, same as column detection itself.
 */

export interface TableBounds {
  /** Index into the original `rows` array where the real table begins. */
  startIndex: number;
  /** Index (inclusive) into the original `rows` array where it ends. */
  endIndex: number;
  skippedLeadingRows: number;
  skippedTrailingRows: number;
}

const SUMMARY_ROW_KEYWORDS = [
  'סה"כ',
  "סהכ",
  "סיכום",
  "total",
  "grand total",
  "עמוד",
  "page",
];

function nonEmptyCount(row: string[]): number {
  return row.filter((c) => c.trim().length > 0).length;
}

function looksLikeSummaryRow(row: string[]): boolean {
  const text = row.join(" ").trim().toLowerCase();
  if (!text) return false;
  return SUMMARY_ROW_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
}

// The table's real column count is whatever non-empty-cell-count is most
// common across all rows with at least 2 non-empty cells — a title row
// (usually 1 cell, sometimes merged-and-propagated into a few identical
// ones) or a footer note doesn't share that width, a genuine header/data
// row does.
function estimateTableWidth(rows: string[][]): number {
  const counts = new Map<number, number>();
  for (const row of rows) {
    const n = nonEmptyCount(row);
    if (n < 2) continue;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  let mode = 0;
  let modeCount = 0;
  for (const [width, count] of counts) {
    if (count > modeCount) {
      mode = width;
      modeCount = count;
    }
  }
  return mode;
}

export function detectTableBounds(rows: string[][]): TableBounds {
  if (rows.length === 0) {
    return { startIndex: 0, endIndex: -1, skippedLeadingRows: 0, skippedTrailingRows: 0 };
  }

  const tableWidth = estimateTableWidth(rows);
  // Allow one missing cell of slack (a header row missing a trailing
  // label, or a data row with one blank optional field) — anything
  // narrower than that is almost certainly not part of the table.
  const widthThreshold = Math.max(2, tableWidth - 1);

  let startIndex = 0;
  while (startIndex < rows.length && nonEmptyCount(rows[startIndex]) < widthThreshold) {
    startIndex += 1;
  }
  // Every row was below the width threshold (a tiny or malformed file) —
  // rather than reporting an empty table, fall back to "no leading rows
  // skipped" so the caller still gets something to work with.
  if (startIndex >= rows.length) startIndex = 0;

  let endIndex = rows.length - 1;
  while (
    endIndex > startIndex &&
    (nonEmptyCount(rows[endIndex]) < widthThreshold || looksLikeSummaryRow(rows[endIndex]))
  ) {
    endIndex -= 1;
  }

  return {
    startIndex,
    endIndex,
    skippedLeadingRows: startIndex,
    skippedTrailingRows: rows.length - 1 - endIndex,
  };
}

// Applies the detected bounds, returning just the real table.
export function extractTable(rows: string[][]): { table: string[][]; bounds: TableBounds } {
  const bounds = detectTableBounds(rows);
  if (bounds.endIndex < bounds.startIndex) return { table: [], bounds };
  return { table: rows.slice(bounds.startIndex, bounds.endIndex + 1), bounds };
}
