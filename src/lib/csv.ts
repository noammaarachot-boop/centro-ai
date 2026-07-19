// Minimal RFC 4180-style CSV parser (quoted fields, "" escaping, CRLF/LF).
// Written by hand instead of adding a dependency: the only external option
// for the broader "Excel/CSV" need (the `xlsx` package) carries unpatched
// high-severity vulnerabilities on npm, so full .xlsx support is deferred;
// this covers the CSV half of FR-005 with zero new dependencies.
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const text = input.replace(/^﻿/, ""); // strip BOM if present

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    // RFC 4180: a field is either fully quoted or not — only treat `"` as
    // the start of a quoted field when it's the field's first character.
    // A `"` appearing mid-field (e.g. Hebrew legal suffix בע"מ, extremely
    // common in real client lists) is a literal character, not a mode
    // toggle — otherwise it swallows the rest of the file as "inside a
    // quote" looking for a closing mark that was never meant to exist.
    if (char === '"' && field.length === 0) {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

export interface CsvClientRow {
  name: string;
  phone: string;
  email: string;
  notes: string;
  // Epic 3: optional explicit business-type column. When an office already
  // knows/tracks this, it's real data and takes priority over the wizard's
  // mocked classifier (src/lib/ai/businessTypeClassifier.ts) — empty string
  // when the column is absent or blank for a row.
  businessType: string;
}

const HEADER_ALIASES: Record<keyof CsvClientRow, string[]> = {
  name: ["name", "שם", "שם לקוח", "שם הלקוח"],
  phone: ["phone", "טלפון", "וואטסאפ", "מספר טלפון"],
  email: ["email", "אימייל", "מייל", "דוא\"ל"],
  notes: ["notes", "הערות"],
  businessType: [
    "business type",
    "businesstype",
    "type",
    "סוג עסק",
    "סוג",
    "ישות משפטית",
  ],
};

function normalizeHeader(value: string) {
  return value.trim().toLowerCase();
}

// Maps whichever columns are present (by Hebrew or English header name) to
// { name, phone, email, notes }. Throws if `name`/`phone` columns are
// missing entirely — everything else is best-effort.
export function parseClientCsv(input: string): CsvClientRow[] {
  const rows = parseCsv(input);
  if (rows.length === 0) return [];

  const header = rows[0].map(normalizeHeader);
  const columnIndex: Partial<Record<keyof CsvClientRow, number>> = {};

  for (const key of Object.keys(HEADER_ALIASES) as (keyof CsvClientRow)[]) {
    const aliases = HEADER_ALIASES[key].map(normalizeHeader);
    const index = header.findIndex((h) => aliases.includes(h));
    if (index >= 0) columnIndex[key] = index;
  }

  if (columnIndex.name === undefined || columnIndex.phone === undefined) {
    throw new Error(
      'הקובץ חייב לכלול עמודות "שם" ו"טלפון" (או name / phone).'
    );
  }

  return rows.slice(1).map((cells) => ({
    name: cells[columnIndex.name!]?.trim() ?? "",
    phone: cells[columnIndex.phone!]?.trim() ?? "",
    email: columnIndex.email !== undefined ? cells[columnIndex.email]?.trim() ?? "" : "",
    notes: columnIndex.notes !== undefined ? cells[columnIndex.notes]?.trim() ?? "" : "",
    businessType:
      columnIndex.businessType !== undefined
        ? cells[columnIndex.businessType]?.trim() ?? ""
        : "",
  }));
}
