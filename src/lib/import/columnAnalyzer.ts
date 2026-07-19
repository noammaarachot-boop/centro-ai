import { matchSynonym } from "@/lib/ai/businessTypeClassifier";

/**
 * Content-based spreadsheet column inference.
 *
 * Real accounting-office files don't reliably use predictable column
 * headers — offices rename them, translate them, add extra columns, or
 * export from systems that produce generic labels ("Column1", "Unnamed: 0")
 * or no header row at all. Header text alone is therefore never sufficient
 * to find the client-name, phone, email, or business-type column; this
 * module scores every column against every candidate role using several
 * independent signals — header text, value-pattern match rate, and
 * structural signals like cardinality — and only trusts the result when
 * those signals agree. When they don't, the caller (the onboarding wizard's
 * import step) shows a human a short confirmation screen instead of
 * guessing silently.
 *
 * Both import formats (CSV, XLSX) funnel through this one analyzer — each
 * format-specific parser only has to produce a plain string[][] grid
 * (src/lib/csv.ts's parseCsv, src/lib/import/xlsxParser.ts's
 * parseXlsxToRows); column understanding is implemented exactly once.
 */

export type ImportRole =
  | "name"
  | "phone"
  | "email"
  | "businessType"
  | "notes"
  | "city"
  | "companyId"
  | "taxId";

// name/phone are required; businessType/email gate their own confidence
// bar; city/companyId/taxId/notes are pure bonus — detected and shown in
// the wizard's understanding summary when found, never required, never
// blocking a confident import when absent.
export interface ColumnMapping {
  name?: number;
  phone?: number;
  email?: number;
  businessType?: number;
  notes?: number;
  city?: number;
  companyId?: number;
  taxId?: number;
}

export interface ColumnAnalysis {
  index: number;
  /** Raw header text, or a synthesized "עמודה N" label when there is no header row. */
  header: string;
  /** 0..1 score per candidate role, for display/debugging and confidence math. */
  scores: Record<ImportRole, number>;
  /** First few non-empty values, for the confirmation UI's preview. */
  sampleValues: string[];
}

export interface AnalyzeColumnsResult {
  hasHeaderRow: boolean;
  /** Header label per column — raw text when hasHeaderRow, else synthesized. */
  headers: string[];
  columns: ColumnAnalysis[];
  mapping: ColumnMapping;
  confidence: "high" | "low";
}

// ---------------------------------------------------------------------------
// Header alias signal — one of several inputs, never the only one (see the
// per-role weights below, where header never exceeds a 0.25 contribution).
// ---------------------------------------------------------------------------

const HEADER_ALIASES: Record<ImportRole, string[]> = {
  name: ["name", "full name", "client name", "שם", "שם לקוח", "שם הלקוח", "שם העסק", "שם מלא"],
  phone: ["phone", "phone number", "mobile", "טלפון", "וואטסאפ", "מספר טלפון", "נייד", "טלפון נייד"],
  email: ["email", "e-mail", "אימייל", "מייל", 'דוא"ל'],
  businessType: [
    "business type",
    "businesstype",
    "type",
    "entity type",
    "classification",
    "service type",
    "סוג עסק",
    "סוג שירות",
    "סוג",
    "סיווג",
    "סוג ישות",
    "ישות משפטית",
    "מעמד",
    "מעמד משפטי",
    "סוג התאגדות",
    "סטטוס עסק",
  ],
  notes: ["notes", "note", "comment", "comments", "הערות", "הערה"],
  city: ["city", "town", "עיר", "ישוב", "יישוב", "עיר מגורים"],
  companyId: [
    "company id",
    "company number",
    "registration number",
    "corporate id",
    'ח.פ',
    'ח"פ',
    "חפ",
    "מספר חברה",
    "מספר רישום",
  ],
  taxId: [
    "tax id",
    "vat number",
    "vat id",
    "tax number",
    'מס"ב',
    "עוסק מורשה מספר",
    "מספר עוסק",
    'מס עוסק',
    'ע.מ',
  ],
};

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase();
}

function headerScore(role: ImportRole, header: string): number {
  const normalized = normalizeHeader(header);
  if (!normalized) return 0;
  for (const alias of HEADER_ALIASES[role]) {
    const normalizedAlias = normalizeHeader(alias);
    if (normalized === normalizedAlias) return 1;
  }
  // Only the "header contains the full alias" direction — generic/short
  // headers (e.g. a bare "B") would otherwise trivially satisfy the
  // reverse containment check against almost any longer alias.
  for (const alias of HEADER_ALIASES[role]) {
    const normalizedAlias = normalizeHeader(alias);
    if (normalizedAlias.length >= 3 && normalized.includes(normalizedAlias)) return 0.6;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Value-pattern signals — the primary signal for every role (see weights).
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailLike(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

// Israeli phone numbers, tolerant of the real-world variance offices export:
// mobile (05X-XXXXXXX, 10 digits with the leading 0) and landline (0X-XXXXXXX,
// 9 digits with the leading 0), any mix of space/dash/dot/parens separators,
// an optional +972/00972/972 country-code prefix, and the leading-zero
// sometimes lost when Excel stores the cell as a number rather than text
// (making a 10-digit mobile read as 9 digits, a 9-digit landline as 8).
// Dates (2020-01-01, 01/02/2020, ...) also collapse to an 8-12 digit run
// once separators are stripped, colliding with the numeric-phone check
// below — reject anything that looks like a date first.
const DATE_LIKE_RE =
  /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$|^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/;

export function isPhoneLike(value: string): boolean {
  const trimmed = value.trim();
  if (DATE_LIKE_RE.test(trimmed)) return false;
  const stripped = trimmed.replace(/[\s\-.()]/g, "");
  if (!stripped) return false;
  let digits = stripped;
  if (digits.startsWith("+972")) digits = digits.slice(4);
  else if (digits.startsWith("00972")) digits = digits.slice(5);
  else if (digits.startsWith("972") && digits.length > 9) digits = digits.slice(3);
  if (!/^\d+$/.test(digits)) return false;
  return digits.length === 8 || digits.length === 9 || digits.length === 10;
}

// Deliberately lenient — any text-ish value can plausibly be a person's or
// business's name. What actually distinguishes a name column from, say, a
// business-type or notes column is the *structural* signal below
// (cardinality): names repeat rarely, categorical values repeat often.
export function isNameLike(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isEmailLike(trimmed)) return false;
  if (isPhoneLike(trimmed)) return false;
  const letterCount = (trimmed.match(/[a-zA-Zא-ת]/g) ?? []).length;
  if (letterCount < 1) return false;
  const digitCount = (trimmed.match(/\d/g) ?? []).length;
  return digitCount <= letterCount;
}

// Reuses the deterministic Hebrew/English business-type synonym dictionary
// (src/lib/ai/businessTypeClassifier.ts) that already drives per-row
// classification — a column is recognized as "business type" by the same
// vocabulary that later classifies each row, so the two layers can never
// disagree about what counts as a valid business-type value.
export function isBusinessTypeLike(value: string): boolean {
  return matchSynonym(value) !== null;
}

// A curated, non-exhaustive set of common Israeli city names (Hebrew and
// English) — a best-effort bonus signal, not a gate: a city column simply
// won't score well if the office uses towns not on this list, and that's
// fine, since city is never required.
const KNOWN_CITIES = new Set(
  [
    "תל אביב", "תל אביב-יפו", "ירושלים", "חיפה", "ראשון לציון", "פתח תקווה",
    "אשדוד", "נתניה", "באר שבע", "בני ברק", "רמת גן", "רחובות", "אשקלון",
    "הרצליה", "כפר סבא", "מודיעין", "רעננה", "בת ים", "חולון", "נצרת",
    "אילת", "לוד", "רמלה", "רמת השרון", "גבעתיים", "הוד השרון", "נהריה",
    "קריית אתא", "קריית גת", "קריית ים", "קריית מוצקין", "קריית ביאליק",
    "עפולה", "טבריה", "דימונה", "יבנה", "אור יהודה", "צפת",
    "tel aviv", "jerusalem", "haifa", "beer sheva", "netanya", "herzliya",
    "ashdod", "rishon lezion", "ramat gan", "petah tikva",
  ].map((c) => c.trim().toLowerCase())
);

export function isCityLike(value: string): boolean {
  return KNOWN_CITIES.has(value.trim().toLowerCase());
}

// Israeli company registration numbers (ח.פ) and tax/VAT-registered
// dealer numbers are both plain 9-digit numbers, sometimes dash-separated
// — structurally indistinguishable from each other, and from a landline
// phone number missing its leading zero. Content alone cannot fully
// disambiguate these three; header text carries proportionally more
// weight for companyId/taxId than for any other role specifically because
// of this (see WEIGHTS below) — an honest, documented limitation rather
// than a false promise of certainty.
export function isNineDigitIdLike(value: string): boolean {
  const stripped = value.trim().replace(/[\s-]/g, "");
  return /^\d{9}$/.test(stripped);
}

const VALUE_PREDICATES: Partial<Record<ImportRole, (value: string) => boolean>> = {
  name: isNameLike,
  phone: isPhoneLike,
  email: isEmailLike,
  businessType: isBusinessTypeLike,
  city: isCityLike,
  companyId: isNineDigitIdLike,
  taxId: isNineDigitIdLike,
};

function patternScore(role: ImportRole, values: string[]): number {
  const predicate = VALUE_PREDICATES[role];
  const nonEmpty = values.filter((v) => v.trim().length > 0);
  if (!predicate || nonEmpty.length === 0) return 0;
  const matches = nonEmpty.filter(predicate).length;
  return matches / nonEmpty.length;
}

// ---------------------------------------------------------------------------
// Structural signal — cardinality relative to row count. A client-identity
// column (name/phone/email) should be close to 1-to-1 with rows; a
// categorical column like business type should repeat a small set of values
// across many rows. This is what keeps a company-name column that happens
// to contain "בע"מ" from ever being mistaken for the business-type column
// (see the module-level comment) — its values are still almost all unique.
// ---------------------------------------------------------------------------

function uniquenessRatio(values: string[]): number {
  const nonEmpty = values.map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (nonEmpty.length === 0) return 0;
  return new Set(nonEmpty).size / nonEmpty.length;
}

const CATEGORICAL_ROLES = new Set<ImportRole>(["businessType", "city"]);

function structureScore(role: ImportRole, values: string[]): number {
  const ratio = uniquenessRatio(values);
  if (CATEGORICAL_ROLES.has(role)) return 1 - ratio; // favor low cardinality
  return ratio; // identity-like columns (name/phone/email/IDs) favor high cardinality
}

// ---------------------------------------------------------------------------
// Weighted combination. Header is capped well below half in every role —
// per the requirement, it is one signal among several, never the deciding
// one on its own.
// ---------------------------------------------------------------------------

const WEIGHTS: Record<ImportRole, { header: number; pattern: number; structure: number }> = {
  name: { header: 0.25, pattern: 0.4, structure: 0.35 },
  phone: { header: 0.25, pattern: 0.65, structure: 0.1 },
  email: { header: 0.2, pattern: 0.75, structure: 0.05 },
  businessType: { header: 0.2, pattern: 0.55, structure: 0.25 },
  notes: { header: 1, pattern: 0, structure: 0 },
  city: { header: 0.3, pattern: 0.6, structure: 0.1 },
  // Header carries more weight here than anywhere else — see
  // isNineDigitIdLike's comment on why content alone can't fully
  // disambiguate a company/tax ID from a phone number.
  companyId: { header: 0.5, pattern: 0.4, structure: 0.1 },
  taxId: { header: 0.5, pattern: 0.4, structure: 0.1 },
};

function totalScore(role: ImportRole, header: string, values: string[]): number {
  if (role === "notes") return headerScore("notes", header);
  const w = WEIGHTS[role];
  const score =
    w.header * headerScore(role, header) +
    w.pattern * patternScore(role, values) +
    w.structure * structureScore(role, values);
  return Math.max(0, Math.min(1, score));
}

// ---------------------------------------------------------------------------
// AI fallback stub for column-role inference — same documented "mock-first"
// contract as classifyViaAI in businessTypeClassifier.ts: no LLM provider is
// configured for this pilot, so this is a deliberate no-op, never a fake
// guess, called only after deterministic scoring has already failed to
// reach a confident assignment and strictly before falling back to asking
// the human via the wizard's mapping-confirmation screen. Wiring in a real
// provider later only touches this one function.
/* eslint-disable @typescript-eslint/no-unused-vars */
async function inferColumnRolesViaAI(
  _headers: string[],
  _sampleRows: string[][]
): Promise<ColumnMapping | null> {
  return null;
}
/* eslint-enable @typescript-eslint/no-unused-vars */

// ---------------------------------------------------------------------------
// Assignment thresholds
// ---------------------------------------------------------------------------

const REQUIRED_ASSIGN_FLOOR = 0.15; // below this, don't even guess
const REQUIRED_HIGH_CONFIDENCE = 0.5;
const AMBIGUITY_MARGIN = 0.15;
const BUSINESS_TYPE_ACCEPT = 0.45;
const EMAIL_ACCEPT = 0.5;
const BONUS_ROLE_ACCEPT = 0.45;

// A real header row is text labels — a genuine column heading is never
// itself a phone number or an email address. So even a single such cell
// in what would be the header row is strong evidence there is no header
// row at all, and every row (including the first) is data.
function detectHeaderRow(firstRow: string[]): boolean {
  const nonEmpty = firstRow.filter((c) => c.trim().length > 0);
  if (nonEmpty.length === 0) return true;
  const looksLikeData = nonEmpty.some((c) => isPhoneLike(c) || isEmailLike(c));
  return !looksLikeData;
}

function synthesizeHeader(index: number): string {
  return `עמודה ${index + 1}`;
}

export function analyzeColumns(rows: string[][]): AnalyzeColumnsResult {
  if (rows.length === 0) {
    return { hasHeaderRow: true, headers: [], columns: [], mapping: {}, confidence: "low" };
  }

  const hasHeaderRow = detectHeaderRow(rows[0]);
  const dataRows = hasHeaderRow ? rows.slice(1) : rows;
  const columnCount = Math.max(...rows.map((r) => r.length));
  const headers = Array.from({ length: columnCount }, (_, i) =>
    hasHeaderRow ? (rows[0][i]?.trim() || synthesizeHeader(i)) : synthesizeHeader(i)
  );

  const columnValues: string[][] = Array.from({ length: columnCount }, (_, i) =>
    dataRows.map((row) => (row[i] ?? "").trim())
  );

  const roles: ImportRole[] = [
    "name",
    "phone",
    "email",
    "businessType",
    "notes",
    "city",
    "companyId",
    "taxId",
  ];
  const columns: ColumnAnalysis[] = Array.from({ length: columnCount }, (_, i) => {
    const values = columnValues[i];
    const scores = Object.fromEntries(
      roles.map((role) => [role, totalScore(role, headers[i], values)])
    ) as Record<ImportRole, number>;
    return {
      index: i,
      header: headers[i],
      scores,
      sampleValues: values.filter((v) => v).slice(0, 3),
    };
  });

  const used = new Set<number>();
  const mapping: ColumnMapping = {};

  // How unambiguously a column suits a role: its score for that role minus
  // its own best score among every *other* role. A column whose values
  // happen to also look plausible for another role (e.g. a business-type
  // column of varied synonym text can score identically to a genuine name
  // column on "name" — see the module-level comment) is less specifically
  // suited to this role than one with a clear lead, even at an equal raw
  // score.
  function specificity(col: ColumnAnalysis, role: ImportRole): number {
    const otherScores = (Object.keys(col.scores) as ImportRole[])
      .filter((r) => r !== role)
      .map((r) => col.scores[r]);
    return col.scores[role] - Math.max(0, ...otherScores);
  }

  function bestRemaining(role: ImportRole): { index: number; score: number } | null {
    let best: { index: number; score: number } | null = null;
    for (const col of columns) {
      if (used.has(col.index)) continue;
      const score = col.scores[role];
      if (!best) {
        best = { index: col.index, score };
        continue;
      }
      if (score > best.score) {
        best = { index: col.index, score };
      } else if (score === best.score) {
        const bestCol = columns[best.index];
        if (specificity(col, role) > specificity(bestCol, role)) {
          best = { index: col.index, score };
        }
      }
    }
    return best;
  }

  // 1. Phone first — the most distinctive, least ambiguous pattern (a
  // digit-string regex), so it never risks losing its column to a fuzzier
  // free-text role once claimed.
  const phoneBest = bestRemaining("phone");
  if (phoneBest && phoneBest.score >= REQUIRED_ASSIGN_FLOOR) {
    mapping.phone = phoneBest.index;
    used.add(phoneBest.index);
  }

  // 2. Name from whatever remains.
  const nameBest = bestRemaining("name");
  if (nameBest && nameBest.score >= REQUIRED_ASSIGN_FLOOR) {
    mapping.name = nameBest.index;
    used.add(nameBest.index);
  }

  // 3. Business type — accepted only above its own confidence bar; below
  // that, requirement 9's path applies (no business-type column found —
  // import anyway, leave clients unclassified, offer manual assignment).
  const businessTypeBest = bestRemaining("businessType");
  if (businessTypeBest && businessTypeBest.score >= BUSINESS_TYPE_ACCEPT) {
    mapping.businessType = businessTypeBest.index;
    used.add(businessTypeBest.index);
  }

  // 4. Email — optional, same accept-or-skip pattern.
  const emailBest = bestRemaining("email");
  if (emailBest && emailBest.score >= EMAIL_ACCEPT) {
    mapping.email = emailBest.index;
    used.add(emailBest.index);
  }

  // 5. Notes — header-only, lowest stakes.
  const notesBest = bestRemaining("notes");
  if (notesBest && notesBest.score > 0) {
    mapping.notes = notesBest.index;
    used.add(notesBest.index);
  }

  // 6-8. Bonus roles (city, company ID, tax ID) — pure best-effort, never
  // required, never affect confidence. Each needs a real, non-trivial
  // score before being claimed, so an ordinary leftover column (a random
  // extra field with no signal at all) is simply left unmapped rather than
  // forced into one of these.
  for (const bonusRole of ["city", "companyId", "taxId"] as const) {
    const best = bestRemaining(bonusRole);
    if (best && best.score >= BONUS_ROLE_ACCEPT) {
      mapping[bonusRole] = best.index;
      used.add(best.index);
    }
  }

  // Ambiguity margins are computed *after* every role has claimed its
  // column, against only the columns that ended up genuinely unclaimed —
  // a column that merely scored close to the name column on "name" but
  // was then confidently claimed for business type isn't a real rival
  // interpretation anymore, so it shouldn't count against confidence here.
  function marginAgainstUnclaimed(role: "name" | "phone", assigned: number): number {
    let bestOther = 0;
    for (const col of columns) {
      if (col.index === assigned || used.has(col.index)) continue;
      if (col.scores[role] > bestOther) bestOther = col.scores[role];
    }
    return columns[assigned].scores[role] - bestOther;
  }

  const requiredResolved = mapping.name !== undefined && mapping.phone !== undefined;
  const requiredConfident =
    requiredResolved &&
    columns[mapping.phone!].scores.phone >= REQUIRED_HIGH_CONFIDENCE &&
    columns[mapping.name!].scores.name >= REQUIRED_HIGH_CONFIDENCE &&
    marginAgainstUnclaimed("phone", mapping.phone!) >= AMBIGUITY_MARGIN &&
    marginAgainstUnclaimed("name", mapping.name!) >= AMBIGUITY_MARGIN;

  return {
    hasHeaderRow,
    headers,
    columns,
    mapping,
    confidence: requiredConfident ? "high" : "low",
  };
}

// Everything in a data row that isn't name/phone/email/businessType — used
// for row-context business-type inference (classifyClientBusinessType's
// layer 2, src/lib/ai/businessTypeClassifier.ts): notes, city, IDs, and
// any column the analyzer didn't confidently map to anything are all still
// fair game for "the rest of the row might mention the legal form," per
// the requirement that classification never looks at a single cell alone.
export function extractRowContextValues(row: string[], mapping: ColumnMapping): string[] {
  const excluded = new Set(
    [mapping.name, mapping.phone, mapping.email, mapping.businessType].filter(
      (i): i is number => i !== undefined
    )
  );
  return row
    .map((cell, index) => (excluded.has(index) ? "" : (cell ?? "").trim()))
    .filter(Boolean);
}

// Async wrapper used by the wizard's import action (already async end to
// end) — analyzeColumns() itself stays synchronous so it remains trivially
// unit-testable and usable from the pure csv.ts mapping helpers. When
// deterministic scoring isn't confident, this is the one seam that gives
// the (currently unconfigured) AI fallback a chance before the caller
// falls through to the human confirmation screen — mirrors
// classifyClientBusinessType's identical priority order for per-row
// classification.
export async function analyzeColumnsWithAIFallback(
  rows: string[][]
): Promise<AnalyzeColumnsResult> {
  const deterministic = analyzeColumns(rows);
  if (deterministic.confidence === "high") return deterministic;

  const aiMapping = await inferColumnRolesViaAI(
    deterministic.headers,
    deterministic.hasHeaderRow ? rows.slice(1, 6) : rows.slice(0, 5)
  );
  if (!aiMapping) return deterministic;

  return { ...deterministic, mapping: aiMapping, confidence: "high" };
}
