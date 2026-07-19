import { describe, expect, it } from "vitest";
import { detectTableBounds, extractTable } from "./spreadsheetStructure";

describe("detectTableBounds", () => {
  it("finds no leading/trailing rows to skip in a clean file", () => {
    const rows = [
      ["name", "phone"],
      ["דנה", "0501111111"],
      ["משה", "0502222222"],
    ];
    const bounds = detectTableBounds(rows);
    expect(bounds.skippedLeadingRows).toBe(0);
    expect(bounds.skippedTrailingRows).toBe(0);
    expect(bounds.startIndex).toBe(0);
    expect(bounds.endIndex).toBe(2);
  });

  it("skips a title row and a blank spacer row above the real table", () => {
    const rows = [
      ["רשימת לקוחות - משרד כהן ושות'"],
      [""],
      ["name", "phone", "email"],
      ["דנה", "0501111111", "dana@x.com"],
      ["משה", "0502222222", "moshe@x.com"],
    ];
    const bounds = detectTableBounds(rows);
    expect(bounds.skippedLeadingRows).toBe(2);
    expect(bounds.startIndex).toBe(2);
  });

  it("skips a trailing summary row below the real table", () => {
    const rows = [
      ["name", "phone"],
      ["דנה", "0501111111"],
      ["משה", "0502222222"],
      ["רותם", "0503333333"],
      ['סה"כ: 3 לקוחות', ""],
    ];
    const bounds = detectTableBounds(rows);
    expect(bounds.skippedTrailingRows).toBe(1);
    expect(bounds.endIndex).toBe(3);
  });

  it("skips both a leading title and a trailing summary in the same file", () => {
    const rows = [
      ["Client Export - Generated Report"],
      ["name", "phone", "email"],
      ["דנה", "0501111111", "dana@x.com"],
      ["משה", "0502222222", "moshe@x.com"],
      ["רותם", "0503333333", "rotem@x.com"],
      ["Total: 3 records"],
    ];
    const bounds = detectTableBounds(rows);
    expect(bounds.skippedLeadingRows).toBe(1);
    expect(bounds.skippedTrailingRows).toBe(1);
  });

  it("handles an empty grid without throwing", () => {
    expect(() => detectTableBounds([])).not.toThrow();
    const bounds = detectTableBounds([]);
    expect(bounds.endIndex).toBeLessThan(bounds.startIndex);
  });
});

describe("extractTable", () => {
  it("returns just the real table, title/footer rows removed", () => {
    const rows = [
      ["רשימת לקוחות"],
      ["name", "phone"],
      ["דנה", "0501111111"],
      ["משה", "0502222222"],
      ['סה"כ: 2'],
    ];
    const { table } = extractTable(rows);
    expect(table).toEqual([
      ["name", "phone"],
      ["דנה", "0501111111"],
      ["משה", "0502222222"],
    ]);
  });
});
