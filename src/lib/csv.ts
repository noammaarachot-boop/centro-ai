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

import { analyzeColumns, type ColumnMapping } from "@/lib/import/columnAnalyzer";

export interface CsvClientRow {
  name: string;
  phone: string;
  email: string;
  notes: string;
  // Epic 3: optional explicit business-type column. When an office already
  // knows/tracks this, it's real data and takes priority over the wizard's
  // classifier (src/lib/ai/businessTypeClassifier.ts) — empty string when
  // the column is absent or blank for a row.
  businessType: string;
}

// Pure "plucking" step — given an already-resolved column mapping (from
// src/lib/import/columnAnalyzer.ts's content-based inference, or from a
// user's manual correction on the wizard's mapping-confirmation screen),
// reads the mapped indices out of each data row. No inference happens
// here; every unmapped role becomes "" rather than undefined.
export function buildClientRowsFromMapping(
  dataRows: string[][],
  mapping: ColumnMapping
): CsvClientRow[] {
  return dataRows.map((cells) => ({
    name: mapping.name !== undefined ? cells[mapping.name]?.trim() ?? "" : "",
    phone: mapping.phone !== undefined ? cells[mapping.phone]?.trim() ?? "" : "",
    email: mapping.email !== undefined ? cells[mapping.email]?.trim() ?? "" : "",
    notes: mapping.notes !== undefined ? cells[mapping.notes]?.trim() ?? "" : "",
    businessType: mapping.businessType !== undefined ? cells[mapping.businessType]?.trim() ?? "" : "",
  }));
}

// Convenience wrapper over the content-based analyzer for callers that just
// want a best-effort mapping with no confirmation step (existing tests,
// and any caller that doesn't need the wizard's low-confidence UI path).
// Still throws if the analyzer can't confidently locate name/phone at all —
// see src/app/onboarding/actions.ts's importAndClassifyClients for the
// real wizard flow, which instead surfaces a mapping-confirmation screen
// rather than failing outright.
export function mapRowsToClientRows(rows: string[][]): CsvClientRow[] {
  if (rows.length === 0) return [];

  const { hasHeaderRow, mapping } = analyzeColumns(rows);
  if (mapping.name === undefined || mapping.phone === undefined) {
    throw new Error('הקובץ חייב לכלול עמודות "שם" ו"טלפון" (או name / phone).');
  }

  const dataRows = hasHeaderRow ? rows.slice(1) : rows;
  return buildClientRowsFromMapping(dataRows, mapping);
}

export function parseClientCsv(input: string): CsvClientRow[] {
  return mapRowsToClientRows(parseCsv(input));
}
