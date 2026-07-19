import { describe, expect, it } from "vitest";
import { mapRowsToClientRows, parseClientCsv, parseCsv } from "./csv";

describe("parseCsv", () => {
  it("parses a simple comma-separated file", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("does not corrupt a field containing a mid-field quote (Hebrew בע\"מ)", () => {
    const input = 'name,phone\nדנה כהן בע"מ,0501111111\nמשה לוי,0502222222';
    expect(parseCsv(input)).toEqual([
      ["name", "phone"],
      ['דנה כהן בע"מ', "0501111111"],
      ["משה לוי", "0502222222"],
    ]);
  });

  it("still supports a properly RFC-4180-quoted field with an embedded comma", () => {
    const input = 'name,notes\n"Cohen, Ltd.","has, a comma"';
    expect(parseCsv(input)).toEqual([
      ["name", "notes"],
      ["Cohen, Ltd.", "has, a comma"],
    ]);
  });

  it("handles CRLF line endings and a trailing BOM-stripped header", () => {
    const input = "﻿name,phone\r\nא,1\r\nב,2";
    expect(parseCsv(input)).toEqual([
      ["name", "phone"],
      ["א", "1"],
      ["ב", "2"],
    ]);
  });
});

describe("mapRowsToClientRows / parseClientCsv", () => {
  it("maps Hebrew headers to the client row shape", () => {
    const rows = parseClientCsv('שם,טלפון,אימייל\nדנה,0501111111,d@x.com');
    expect(rows).toEqual([
      {
        name: "דנה",
        phone: "0501111111",
        email: "d@x.com",
        notes: "",
        businessType: "",
        otherValues: [],
      },
    ]);
  });

  it("recognizes a business-type column by several realistic Hebrew header variants", () => {
    for (const header of ["סוג עסק", "סיווג", "מעמד משפטי", "type"]) {
      const rows = mapRowsToClientRows([
        ["name", "phone", header],
        ["א", "1", 'חברה בע"מ'],
      ]);
      expect(rows[0].businessType).toBe('חברה בע"מ');
    }
  });

  it("throws a clear error when name/phone columns are both missing", () => {
    expect(() => parseClientCsv("email,notes\na@b.com,hi")).toThrowError(/שם.*טלפון/);
  });

  it("treats missing optional columns as empty strings, not undefined", () => {
    const rows = parseClientCsv("name,phone\nא,1");
    expect(rows[0].email).toBe("");
    expect(rows[0].notes).toBe("");
    expect(rows[0].businessType).toBe("");
  });
});
