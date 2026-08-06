import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { mergePagesToPdf } from "./documentMerge";

// Real single-PDF merging — mergePagesToPdf is pure given already-downloaded
// bytes, so these tests exercise the actual pdf-lib merge logic end to end
// (not mocked) and verify the real resulting PDF's page count/order.

async function makeOnePagePdf(label: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  page.drawText(label, { x: 10, y: 100 });
  return Buffer.from(await doc.save());
}

describe("mergePagesToPdf", () => {
  it("merges several single-page PDFs into one PDF with every page, in order", async () => {
    const page1 = await makeOnePagePdf("page1");
    const page2 = await makeOnePagePdf("page2");
    const page3 = await makeOnePagePdf("page3");

    const merged = await mergePagesToPdf([
      { bytes: page1, mimeType: "application/pdf" },
      { bytes: page2, mimeType: "application/pdf" },
      { bytes: page3, mimeType: "application/pdf" },
    ]);

    const result = await PDFDocument.load(merged);
    expect(result.getPageCount()).toBe(3);
  });

  it("merges a multi-page source PDF's own pages in alongside single pages", async () => {
    const twoPageSource = await PDFDocument.create();
    twoPageSource.addPage([200, 200]);
    twoPageSource.addPage([200, 200]);
    const twoPageBytes = Buffer.from(await twoPageSource.save());
    const singlePage = await makeOnePagePdf("extra");

    const merged = await mergePagesToPdf([
      { bytes: twoPageBytes, mimeType: "application/pdf" },
      { bytes: singlePage, mimeType: "application/pdf" },
    ]);

    const result = await PDFDocument.load(merged);
    expect(result.getPageCount()).toBe(3);
  });

  it("a single page produces a valid one-page PDF (the minimal merge case)", async () => {
    const page = await makeOnePagePdf("solo");
    const merged = await mergePagesToPdf([{ bytes: page, mimeType: "application/pdf" }]);
    const result = await PDFDocument.load(merged);
    expect(result.getPageCount()).toBe(1);
  });

  it("throws on an unsupported mime type rather than silently producing a broken/empty result", async () => {
    await expect(mergePagesToPdf([{ bytes: Buffer.from("not real"), mimeType: "image/heic" }])).rejects.toThrow();
  });
});
