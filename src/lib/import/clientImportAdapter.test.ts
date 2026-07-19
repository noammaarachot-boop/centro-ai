import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  analyzeImportFileStructure,
  parseClientImportFile,
  UnsupportedImportFormatError,
} from "./clientImportAdapter";

async function xlsxFile(
  rows: (string | number)[][],
  name = "clients.xlsx",
  build?: (workbook: ExcelJS.Workbook, sheet: ExcelJS.Worksheet) => void,
  sheetName = "Clients"
): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  rows.forEach((row) => sheet.addRow(row));
  build?.(workbook, sheet);
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
      {
        name: "דנה",
        phone: "0501111111",
        email: "",
        notes: "",
        businessType: 'חברה בע"מ',
        otherValues: [],
      },
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

describe("analyzeImportFileStructure — STEP 1 spreadsheet understanding", () => {
  it("picks the worksheet with the most data when a workbook has multiple sheets", async () => {
    const file = await xlsxFile(
      [["This workbook has instructions on the cover sheet"]],
      "clients.xlsx",
      (workbook) => {
        const dataSheet = workbook.addWorksheet("Clients");
        dataSheet.addRow(["name", "phone"]);
        dataSheet.addRow(["דנה", "0501111111"]);
        dataSheet.addRow(["משה", "0502222222"]);
      },
      "Cover"
    );

    const structure = await analyzeImportFileStructure(file);
    expect(structure.xlsxMeta?.sheetNames).toEqual(["Cover", "Clients"]);
    expect(structure.xlsxMeta?.sheetUsed).toBe("Clients");
    expect(structure.rows.some((r) => r.includes("דנה"))).toBe(true);
  });

  it("detects hidden columns without excluding their data", async () => {
    const file = await xlsxFile(
      [
        ["name", "phone", "internal"],
        ["דנה", "0501111111", "x"],
      ],
      "clients.xlsx",
      (_wb, sheet) => {
        sheet.getColumn(3).hidden = true;
      }
    );

    const structure = await analyzeImportFileStructure(file);
    expect(structure.xlsxMeta?.hiddenColumnIndexes).toContain(2);
    expect(structure.rows[1]).toEqual(["דנה", "0501111111", "x"]);
  });

  it("detects merged cells and reports them (ExcelJS already resolves their values)", async () => {
    const file = await xlsxFile(
      [
        ["name", "phone", "type"],
        ["דנה", "0501111111", 'חברה בע"מ'],
        ["משה", "0502222222", ""],
      ],
      "clients.xlsx",
      (_wb, sheet) => {
        sheet.mergeCells("C2:C3");
      }
    );

    const structure = await analyzeImportFileStructure(file);
    expect(structure.xlsxMeta?.hadMergedCells).toBe(true);
    // The merged value propagates to every row in the merged range.
    expect(structure.rows[1][2]).toBe('חברה בע"מ');
    expect(structure.rows[2][2]).toBe('חברה בע"מ');
  });

  it("skips a title row above the real table (CSV)", async () => {
    const file = csvFile(
      'רשימת לקוחות - משרד כהן\n\nname,phone\nדנה,0501111111\nמשה,0502222222'
    );
    const structure = await analyzeImportFileStructure(file);
    expect(structure.tableBounds.skippedLeadingRows).toBeGreaterThan(0);
    expect(structure.rows[0]).toEqual(["name", "phone"]);
  });

  it("skips a trailing summary row below the real table (CSV)", async () => {
    const file = csvFile(
      'name,phone\nדנה,0501111111\nמשה,0502222222\nרותם,0503333333\n"סה""כ: 3 לקוחות",'
    );
    const structure = await analyzeImportFileStructure(file);
    expect(structure.tableBounds.skippedTrailingRows).toBeGreaterThan(0);
    expect(structure.rows.some((r) => r.join("").includes('סה"כ'))).toBe(false);
  });
});
