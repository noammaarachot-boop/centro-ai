import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseXlsxToRows } from "./xlsxParser";
import { mapRowsToClientRows } from "@/lib/csv";

async function buildWorkbookBuffer(rows: (string | number)[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Clients");
  rows.forEach((row) => sheet.addRow(row));
  return workbook.xlsx.writeBuffer();
}

describe("parseXlsxToRows", () => {
  it("reads a simple worksheet into string[][], including Hebrew text", async () => {
    const buffer = await buildWorkbookBuffer([
      ["name", "phone", "email"],
      ['דנה כהן בע"מ', "0501111111", "dana@example.com"],
    ]);

    const rows = await parseXlsxToRows(buffer);
    expect(rows).toEqual([
      ["name", "phone", "email"],
      ['דנה כהן בע"מ', "0501111111", "dana@example.com"],
    ]);
  });

  it("stringifies numeric cells (e.g. a phone number Excel stored as a number)", async () => {
    const buffer = await buildWorkbookBuffer([
      ["name", "phone"],
      ["א", 501111111],
    ]);

    const rows = await parseXlsxToRows(buffer);
    expect(rows[1]).toEqual(["א", "501111111"]);
  });

  it("skips fully blank rows", async () => {
    const buffer = await buildWorkbookBuffer([
      ["name", "phone"],
      ["א", "1"],
      ["", ""],
      ["ב", "2"],
    ]);

    const rows = await parseXlsxToRows(buffer);
    expect(rows).toEqual([
      ["name", "phone"],
      ["א", "1"],
      ["ב", "2"],
    ]);
  });

  it("round-trips through mapRowsToClientRows exactly like the CSV path", async () => {
    const buffer = await buildWorkbookBuffer([
      ["שם", "טלפון", "סוג עסק"],
      ["דנה", "0501111111", "עוסק מורשה"],
    ]);

    const rows = await parseXlsxToRows(buffer);
    const clientRows = mapRowsToClientRows(rows);
    expect(clientRows).toEqual([
      {
        name: "דנה",
        phone: "0501111111",
        email: "",
        notes: "",
        businessType: "עוסק מורשה",
      },
    ]);
  });
});
