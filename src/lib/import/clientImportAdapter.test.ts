import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseClientImportFile, UnsupportedImportFormatError } from "./clientImportAdapter";

async function xlsxFile(rows: string[][], name = "clients.xlsx"): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Clients");
  rows.forEach((row) => sheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer as ArrayBuffer], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function csvFile(content: string, name = "clients.csv"): File {
  return new File([content], name, { type: "text/csv" });
}

describe("parseClientImportFile", () => {
  it("parses a real .xlsx file end to end", async () => {
    const file = await xlsxFile([
      ["name", "phone", "business type"],
      ["דנה", "0501111111", 'חברה בע"מ'],
    ]);

    const rows = await parseClientImportFile(file);
    expect(rows).toEqual([
      { name: "דנה", phone: "0501111111", email: "", notes: "", businessType: 'חברה בע"מ' },
    ]);
  });

  it("parses a .csv file end to end", async () => {
    const file = csvFile("name,phone\nדנה,0501111111");
    const rows = await parseClientImportFile(file);
    expect(rows[0].name).toBe("דנה");
  });

  it("rejects legacy .xls with a friendly, actionable message", async () => {
    const file = new File(["binary"], "clients.xls", { type: "application/vnd.ms-excel" });
    await expect(parseClientImportFile(file)).rejects.toBeInstanceOf(UnsupportedImportFormatError);
  });

  it("rejects an unrecognized extension", async () => {
    const file = new File(["hi"], "clients.txt", { type: "text/plain" });
    await expect(parseClientImportFile(file)).rejects.toBeInstanceOf(UnsupportedImportFormatError);
  });
});
