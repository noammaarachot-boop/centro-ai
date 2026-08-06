/**
 * Synthetic test fixtures for the document-collection E2E suite — every
 * "document" here is a tiny, clearly-labeled, entirely fabricated file.
 * None of these represent a real person, a real ID number, or real
 * banking/employment data. Every fixture's own label makes this explicit
 * so it's unmistakable in any log, Drive folder, or screenshot: "מסמך
 * בדיקה בלבד — לא מסמך אמיתי".
 */

// The smallest possible valid 1x1 PNG — real, parseable image bytes (not a
// placeholder string), so anything that actually decodes the file (pdf-lib
// embedding, real Drive upload) works against genuine image data.
export const TEST_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

// A minimal, real, valid single-page PDF (not a placeholder string) —
// parseable by pdf-lib, produced once by hand via pdf-lib itself and
// hex-encoded here so the fixtures module has no async/build-time
// dependency on pdf-lib to construct it.
// pdf-lib's built-in standard fonts only support WinAnsi (Latin) encoding
// — no Hebrew glyphs — so the page's own visible marker text is English;
// the Hebrew label (fixture metadata, used in logs/assertions elsewhere)
// isn't rendered as glyphs on the page itself.
export async function buildTestPdfBytes(): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 150]);
  page.drawText("TEST DOCUMENT ONLY - NOT REAL", { x: 10, y: 120, size: 10, font });
  page.drawText("Synthetic E2E fixture, no real personal data", { x: 10, y: 90, size: 8, font });
  return Buffer.from(await doc.save());
}

export type FixtureKind =
  | "id_card"
  | "drivers_license"
  | "passport"
  | "payslip"
  | "invoice"
  | "lease_certificate"
  | "bank_statement"
  | "blurred"
  | "unrelated_document";

export interface TestDocument {
  kind: FixtureKind;
  label: string;
  fileName: string;
  mimeType: "image/png" | "application/pdf";
  bytes: Buffer;
}

// Every synthetic person/company name below is fabricated for this test
// suite only — chosen to be obviously fictitious, never resembling a real
// individual or business.
export async function makeTestDocument(
  kind: FixtureKind,
  overrides: Partial<Pick<TestDocument, "label" | "fileName">> = {}
): Promise<TestDocument> {
  const defaults: Record<FixtureKind, { label: string; fileName: string }> = {
    id_card: { label: "מסמך בדיקה בלבד — תעודת זהות פיקטיבית — ישראל ישראלי בדיקה", fileName: "test_id_card.png" },
    drivers_license: { label: "מסמך בדיקה בלבד — רישיון נהיגה פיקטיבי — ישראל ישראלי בדיקה", fileName: "test_license.png" },
    passport: { label: "מסמך בדיקה בלבד — דרכון פיקטיבי — ישראל ישראלי בדיקה", fileName: "test_passport.png" },
    payslip: { label: "מסמך בדיקה בלבד — תלוש שכר פיקטיבי — חברת בדיקה בע\"מ", fileName: "test_payslip.pdf" },
    invoice: { label: "מסמך בדיקה בלבד — חשבונית פיקטיבית — חברת בדיקה בע\"מ", fileName: "test_invoice.pdf" },
    lease_certificate: { label: "מסמך בדיקה בלבד — אישור שכירות פיקטיבי", fileName: "test_lease.pdf" },
    bank_statement: { label: "מסמך בדיקה בלבד — דף בנק פיקטיבי", fileName: "test_bank_statement.pdf" },
    blurred: { label: "מסמך בדיקה בלבד — סריקה מטושטשת מכוונת לבדיקה", fileName: "test_blurred.png" },
    unrelated_document: { label: "מסמך בדיקה בלבד — מסמך שאינו שייך לאף דרישה", fileName: "test_unrelated.pdf" },
  };
  const chosen = { ...defaults[kind], ...overrides };
  const isPdf = defaults[kind].fileName.endsWith(".pdf");
  const bytes = isPdf ? await buildTestPdfBytes() : TEST_PNG_BYTES;
  return {
    kind,
    label: chosen.label,
    fileName: chosen.fileName,
    mimeType: isPdf ? "application/pdf" : "image/png",
    bytes,
  };
}
