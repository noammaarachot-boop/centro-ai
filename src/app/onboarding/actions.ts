"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { getDb } from "@/db";
import { clients, organizations, services } from "@/db/schema";
import {
  parseClientImportFileToGrid,
  UnsupportedImportFormatError,
} from "@/lib/import/clientImportAdapter";
import {
  analyzeColumnsWithAIFallback,
  type AnalyzeColumnsResult,
  type ColumnMapping,
} from "@/lib/import/columnAnalyzer";
import { buildClientRowsFromMapping } from "@/lib/csv";
import { recordAuditEvent } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { markOnboardingComplete } from "@/lib/onboarding";
import {
  assignClientsToBusinessType,
  createBusinessType,
  getSuggestedRequirements,
  seedStarterBusinessTypes,
} from "@/lib/businessTypes";
import { classifyClientBusinessType } from "@/lib/ai/businessTypeClassifier";

async function setOnboardingStep(organizationId: string, step: number) {
  const db = await getDb();
  await db
    .update(organizations)
    .set({ onboardingStep: step, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId));
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

export interface OfficeInfoState {
  fieldErrors?: { name?: string };
}

// Step 2 — this is where the placeholder organization name set at
// registration (src/app/login/actions.ts's register(), Epic 2) becomes the
// real one. Logo is optional and only overwritten when a new one was
// actually picked (see Step2OfficeInfo.tsx's client-side resize-to-data-URL
// handling) — revisiting this step without re-picking a logo never clears
// an existing one.
export async function updateOfficeInfo(
  _prevState: OfficeInfoState,
  formData: FormData
): Promise<OfficeInfoState> {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  const logoDataUrl = String(formData.get("logoDataUrl") ?? "").trim();
  const returnTo = formData.get("returnTo")?.toString();

  if (!name) {
    return { fieldErrors: { name: "נא להזין שם משרד." } };
  }

  const db = await getDb();
  await db
    .update(organizations)
    .set({
      name,
      ...(logoDataUrl ? { logoUrl: logoDataUrl } : {}),
      ...(returnTo ? {} : { onboardingStep: 3 }),
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, session.organizationId));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "organization.updated",
    description: returnTo ? "פרטי המשרד עודכנו מההגדרות" : "פרטי המשרד עודכנו באשף ההקמה",
    actorType: "employee",
    actorUserId: session.userId,
  });

  // `returnTo` (Settings) means this form was submitted from the exact
  // page we'd redirect back to — refresh() (Next.js 16) instead, since
  // redirect() to an identical URL doesn't reliably force a fresh client
  // render. No `returnTo` means the wizard's real step2 -> step3
  // navigation, a genuinely different page, where redirect() is correct.
  if (returnTo) {
    refresh();
    return {};
  }
  redirect("/onboarding?step=3");
}

// Step 7 — per-Business-Type (i.e. per-Service) reminder/business-hours
// overrides. `useOverrides` is a single "customize for this business type"
// toggle: off clears all five columns back to null (use the organization's
// default, from Settings), on writes the submitted values. Also reachable
// post-wizard from that service's own /services/[id] page — see
// src/app/(app)/services/[id]/page.tsx.
export async function updateServiceScheduleOverrides(
  serviceId: string,
  formData: FormData
) {
  const session = await requireSession();
  const db = await getDb();

  const [service] = await db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.organizationId, session.organizationId)))
    .limit(1);
  if (!service) redirect("/onboarding?step=7");

  const useOverrides = formData.get("useOverrides") === "on";

  if (!useOverrides) {
    await db
      .update(services)
      .set({
        businessHoursStartOverride: null,
        businessHoursEndOverride: null,
        businessDaysOverride: null,
        reminderIntervalDaysOverride: null,
        inactivityTimeoutMinutesOverride: null,
        updatedAt: new Date(),
      })
      .where(eq(services.id, serviceId));
  } else {
    const businessDaysOverride = WEEKDAYS.filter(
      (day) => formData.get(`day-${day}`) === "on"
    ).join(",");

    await db
      .update(services)
      .set({
        businessHoursStartOverride: String(formData.get("businessHoursStart") ?? "09:00"),
        businessHoursEndOverride: String(formData.get("businessHoursEnd") ?? "18:00"),
        businessDaysOverride: businessDaysOverride || "0,1,2,3,4",
        reminderIntervalDaysOverride: Number(formData.get("reminderIntervalDays") ?? 2),
        inactivityTimeoutMinutesOverride: Number(
          formData.get("inactivityTimeoutMinutes") ?? 15
        ),
        updatedAt: new Date(),
      })
      .where(eq(services.id, serviceId));
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "service.schedule_overrides_updated",
    description: "כללי תזכורות עודכנו עבור סוג עסק",
    actorType: "employee",
    actorUserId: session.userId,
  });

  // Always a same-page submission (Step 7 or the service's own page) —
  // refresh() alone, no redirect(); see addRequirement's comment in
  // src/app/(app)/services/actions.ts for why.
  refresh();
}

// Generic "move forward" action for steps whose Next button has nothing
// else to persist (e.g. after reviewing connection status, or once
// satisfied with a checklist) — bound to the target step via
// `.bind(null, nextStep)`, matching this codebase's existing pattern for
// parameterized actions (see e.g. src/app/(app)/clients/actions.ts).
export async function advanceOnboardingStep(nextStep: number) {
  const session = await requireSession();
  await setOnboardingStep(session.organizationId, nextStep);
  redirect(`/onboarding?step=${nextStep}`);
}

async function setIntegrationTimestamp(
  column: "googleConnectedAt" | "whatsappConnectedAt",
  value: Date | null,
  eventType: string,
  description: string
) {
  const session = await requireSession();
  const db = await getDb();
  await db
    .update(organizations)
    .set({ [column]: value, updatedAt: new Date() })
    .where(eq(organizations.id, session.organizationId));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType,
    description,
    actorType: "employee",
    actorUserId: session.userId,
  });

  // Always submitted from Step 3 itself — refresh() alone, no redirect().
  refresh();
}

// Google/WhatsApp connection is mocked here per the "build against mocks
// first" decision — these set the same organizations columns a real OAuth
// callback will set in M5/M6, so the activation gate below never has to
// change.
export async function connectGoogle() {
  await setIntegrationTimestamp(
    "googleConnectedAt",
    new Date(),
    "integration.google_connected",
    "חשבון Google חובר (הדגמה)"
  );
}

export async function disconnectGoogle() {
  await setIntegrationTimestamp(
    "googleConnectedAt",
    null,
    "integration.google_disconnected",
    "חיבור חשבון Google נותק"
  );
}

export async function connectWhatsapp() {
  await setIntegrationTimestamp(
    "whatsappConnectedAt",
    new Date(),
    "integration.whatsapp_connected",
    "חשבון WhatsApp Business חובר (הדגמה)"
  );
}

export async function disconnectWhatsapp() {
  await setIntegrationTimestamp(
    "whatsappConnectedAt",
    null,
    "integration.whatsapp_disconnected",
    "חיבור WhatsApp Business נותק"
  );
}

// BR-001 (Ch.3): automation cannot be activated until all mandatory
// integrations are connected. Shared by the explicit Settings toggle below
// and finishOnboarding()'s best-effort activation — the gate itself never
// redirects, so it's safe to call from a context (wizard completion) that
// shouldn't fail loudly just because an office skipped connecting.
async function tryActivateAutomation(session: {
  organizationId: string;
  userId: string;
}): Promise<boolean> {
  const db = await getDb();
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, session.organizationId))
    .limit(1);

  if (!organization?.googleConnectedAt || !organization?.whatsappConnectedAt) {
    return false;
  }
  if (organization.automationActivatedAt) return true;

  await db
    .update(organizations)
    .set({ automationActivatedAt: new Date(), updatedAt: new Date() })
    .where(eq(organizations.id, session.organizationId));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "automation.activated",
    description: "האוטומציה הופעלה",
    actorType: "employee",
    actorUserId: session.userId,
  });

  return true;
}

// Manual toggle, reachable from Settings post-onboarding (the wizard itself
// never shows this button — see finishOnboarding below).
export async function activateAutomation() {
  const session = await requireSession();
  const activated = await tryActivateAutomation(session);
  if (!activated) {
    // Genuine URL change (adds the error query param) — redirect() is
    // correct here, no staleness risk.
    redirect("/settings?error=integrations-required");
  }
  // Always submitted from /settings itself — refresh() alone, no redirect().
  refresh();
}

export async function deactivateAutomation() {
  const session = await requireSession();
  const db = await getDb();
  await db
    .update(organizations)
    .set({ automationActivatedAt: null, updatedAt: new Date() })
    .where(eq(organizations.id, session.organizationId));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "automation.deactivated",
    description: "האוטומציה הושבתה",
    actorType: "employee",
    actorUserId: session.userId,
  });

  refresh();
}

// Step 9's "Go to Dashboard" — the wizard's real completion action.
// Best-effort activates automation (silently skipped if the office never
// connected both integrations in Step 3; nothing here blocks finishing),
// then marks onboarding complete so every subsequent login goes straight
// to the Dashboard instead of back through this wizard.
export async function finishOnboarding() {
  const session = await requireSession();
  await tryActivateAutomation(session);
  await markOnboardingComplete(session.organizationId);

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "onboarding.completed",
    description: "אשף ההקמה הושלם",
    actorType: "employee",
    actorUserId: session.userId,
  });

  redirect("/dashboard");
}

export interface SkippedImportRow {
  row: number;
  name: string;
  reason: string;
}

export interface ImportAnalysisSummary {
  confidence: "high" | "low";
  detectedColumns: {
    name?: string;
    phone?: string;
    email?: string;
    businessType?: string;
  };
  classified: number;
  needsReview: number;
}

export interface ImportClientsState {
  error?: string;
  result?: {
    imported: number;
    skipped: SkippedImportRow[];
  };
  // Populated instead of `result` when the content-based column analyzer
  // (src/lib/import/columnAnalyzer.ts) can't confidently locate the
  // required columns on its own — the wizard shows a short confirmation
  // screen instead of guessing. `rows`/`hasHeaderRow` round-trip back
  // through confirmImportMapping below once the user confirms/corrects it,
  // so the file never needs to be re-uploaded.
  needsMapping?: {
    rows: string[][];
    hasHeaderRow: boolean;
    headers: string[];
    sampleRows: string[][];
    suggestion: ColumnMapping;
  };
}

// Shared by both the confident-auto-import path and the
// confirm-mapping path below: inserts new clients (same duplicate-phone
// handling the pre-wizard importer always had), then runs the deterministic
// per-row classifier (src/lib/ai/businessTypeClassifier.ts) against every
// newly imported client, seeding the five starter Business Types on first
// use. Records one audit event carrying the column-analysis summary
// (src/app/onboarding/page.tsx's Step 5 case reads the latest one back to
// render "which column did Centro use for X" — requirement 14) plus the
// existing imported/classified events.
async function importParsedRows(
  session: { organizationId: string; userId: string },
  parsedRows: Array<{ name: string; phone: string; email: string; notes: string; businessType: string }>,
  analysis: AnalyzeColumnsResult
): Promise<ImportClientsState> {
  const db = await getDb();
  const existing = await db
    .select({ phone: clients.phone })
    .from(clients)
    .where(eq(clients.organizationId, session.organizationId));
  const existingPhones = new Set(existing.map((c) => c.phone));

  const skipped: SkippedImportRow[] = [];
  const importedRows: Array<{ id: string; name: string; businessType: string }> = [];

  for (let i = 0; i < parsedRows.length; i += 1) {
    const row = parsedRows[i];
    const rowNumber = i + (analysis.hasHeaderRow ? 2 : 1); // +1 for header (if any), +1 for 1-indexing

    if (!row.name || !row.phone) {
      skipped.push({ row: rowNumber, name: row.name || "—", reason: "חסר שם או טלפון" });
      continue;
    }
    if (existingPhones.has(row.phone)) {
      skipped.push({ row: rowNumber, name: row.name, reason: "מספר טלפון כבר קיים" });
      continue;
    }

    const [inserted] = await db
      .insert(clients)
      .values({
        organizationId: session.organizationId,
        name: row.name,
        phone: row.phone,
        email: row.email || null,
        notes: row.notes || null,
      })
      .returning({ id: clients.id, name: clients.name });

    existingPhones.add(row.phone);
    importedRows.push({ id: inserted.id, name: inserted.name, businessType: row.businessType });
  }

  const detectedColumns: ImportAnalysisSummary["detectedColumns"] = {
    name: analysis.mapping.name !== undefined ? analysis.headers[analysis.mapping.name] : undefined,
    phone: analysis.mapping.phone !== undefined ? analysis.headers[analysis.mapping.phone] : undefined,
    email: analysis.mapping.email !== undefined ? analysis.headers[analysis.mapping.email] : undefined,
    businessType:
      analysis.mapping.businessType !== undefined
        ? analysis.headers[analysis.mapping.businessType]
        : undefined,
  };

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "clients.imported",
    description: `${importedRows.length} לקוחות יובאו (${skipped.length} דולגו)`,
    actorType: "employee",
    actorUserId: session.userId,
    metadata: { imported: importedRows.length, skippedCount: skipped.length },
  });

  let classifiedCount = 0;
  if (importedRows.length > 0) {
    const businessTypeList = await seedStarterBusinessTypes(session.organizationId);
    const candidates = businessTypeList.map((t) => ({ id: t.id, name: t.name }));

    const groupedByType = new Map<string, string[]>();
    for (const row of importedRows) {
      const { businessTypeId } = await classifyClientBusinessType(
        row.name,
        candidates,
        row.businessType
      );
      if (!businessTypeId) continue;
      classifiedCount += 1;
      const clientIds = groupedByType.get(businessTypeId) ?? [];
      clientIds.push(row.id);
      groupedByType.set(businessTypeId, clientIds);
    }

    for (const [businessTypeId, clientIds] of groupedByType) {
      await assignClientsToBusinessType(session.organizationId, clientIds, businessTypeId);
    }

    await recordAuditEvent({
      organizationId: session.organizationId,
      eventType: "clients.classified",
      description: `${classifiedCount} מתוך ${importedRows.length} לקוחות שיובאו סווגו אוטומטית לפי סוג עסק`,
      actorType: "ai",
      metadata: {
        classified: classifiedCount,
        unclassified: importedRows.length - classifiedCount,
      },
    });
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "clients.import_analyzed",
    description: "Centro ניתח את מבנה הקובץ שיובא",
    actorType: "ai",
    metadata: {
      confidence: analysis.confidence,
      detectedColumns,
      classified: classifiedCount,
      needsReview: importedRows.length - classifiedCount,
    },
  });

  await setOnboardingStep(session.organizationId, 5);
  redirect("/onboarding?step=5");
}

// Step 4 ("Import Excel / CSV") + Step 5 ("AI Client Analysis") in one
// action. Parses the file into a raw grid (format-agnostic — CSV and XLSX
// share this exact path) and runs it through the content-based column
// analyzer (src/lib/import/columnAnalyzer.ts), which infers the
// client-name/phone/email/business-type columns from the *values*, not
// just the header text — real office files rename, reorder, or omit
// headers entirely. When the analyzer is confident, the import proceeds
// automatically exactly like before; when it isn't, this returns
// `needsMapping` instead of importing anything, and confirmImportMapping
// below finishes the job once the user confirms or corrects the mapping.
export async function importAndClassifyClients(
  _prevState: ImportClientsState,
  formData: FormData
): Promise<ImportClientsState> {
  const session = await requireSession();
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return { error: "נא לבחור קובץ להעלאה." };
  }

  let rawRows: string[][];
  try {
    rawRows = await parseClientImportFileToGrid(file);
  } catch (error) {
    if (error instanceof UnsupportedImportFormatError) {
      return { error: error.message };
    }
    return { error: error instanceof Error ? error.message : "שגיאה בקריאת הקובץ." };
  }

  const analysis = await analyzeColumnsWithAIFallback(rawRows);

  if (analysis.confidence !== "high") {
    const dataRows = analysis.hasHeaderRow ? rawRows.slice(1) : rawRows;
    return {
      needsMapping: {
        rows: rawRows,
        hasHeaderRow: analysis.hasHeaderRow,
        headers: analysis.headers,
        sampleRows: dataRows.slice(0, 5),
        suggestion: analysis.mapping,
      },
    };
  }

  const dataRows = analysis.hasHeaderRow ? rawRows.slice(1) : rawRows;
  const parsedRows = buildClientRowsFromMapping(dataRows, analysis.mapping);
  return importParsedRows(session, parsedRows, analysis);
}

// The mapping-confirmation screen's submit action — same shared import
// logic as importAndClassifyClients above, just with a human-confirmed (or
// corrected) column mapping instead of the analyzer's own best guess. The
// original file never needs to be re-uploaded: the raw grid parsed on the
// first pass round-trips through the form as JSON.
export async function confirmImportMapping(
  _prevState: ImportClientsState,
  formData: FormData
): Promise<ImportClientsState> {
  const session = await requireSession();

  let rows: string[][];
  try {
    rows = JSON.parse(String(formData.get("rows") ?? "[]"));
  } catch {
    return { error: "אירעה שגיאה בטעינת הקובץ מחדש. נא להעלות אותו שוב." };
  }
  const hasHeaderRow = formData.get("hasHeaderRow") === "1";

  function selectedColumn(field: string): number | undefined {
    const value = formData.get(field);
    if (!value || value === "") return undefined;
    const index = Number(value);
    return Number.isInteger(index) ? index : undefined;
  }

  const mapping: ColumnMapping = {
    name: selectedColumn("map-name"),
    phone: selectedColumn("map-phone"),
    email: selectedColumn("map-email"),
    businessType: selectedColumn("map-businessType"),
  };

  if (mapping.name === undefined || mapping.phone === undefined) {
    return { error: "יש לבחור עמודה עבור שם וטלפון לפני שממשיכים." };
  }

  const dataRows = hasHeaderRow ? rows.slice(1) : rows;
  const headers =
    rows.length > 0
      ? rows[0].map((h, i) => (hasHeaderRow && h.trim() ? h.trim() : `עמודה ${i + 1}`))
      : [];
  const parsedRows = buildClientRowsFromMapping(dataRows, mapping);

  return importParsedRows(session, parsedRows, {
    hasHeaderRow,
    headers,
    columns: [],
    mapping,
    confidence: "high",
  });
}

// Step 5's "Assign Business Type" bulk action — covers both picking an
// existing type and (via `newTypeName`) creating one inline, so the user
// never has to leave the wizard or edit a spreadsheet to finish
// classifying.
export async function assignBusinessTypeAction(formData: FormData) {
  const session = await requireSession();
  const clientIds = formData.getAll("clientId").map(String).filter(Boolean);
  const newTypeName = String(formData.get("newTypeName") ?? "").trim();
  let businessTypeId = String(formData.get("businessTypeId") ?? "");

  if (newTypeName) {
    const created = await createBusinessType(session.organizationId, newTypeName, {
      isCustom: true,
      seedRequirements: getSuggestedRequirements(newTypeName),
    });
    businessTypeId = created.id;

    await recordAuditEvent({
      organizationId: session.organizationId,
      eventType: "business_type.created",
      description: `סוג עסק "${newTypeName}" נוצר`,
      actorType: "employee",
      actorUserId: session.userId,
    });
  }

  if (businessTypeId && clientIds.length > 0) {
    await assignClientsToBusinessType(session.organizationId, clientIds, businessTypeId);

    await recordAuditEvent({
      organizationId: session.organizationId,
      eventType: "clients.business_type_assigned",
      description: `${clientIds.length} לקוחות שויכו לסוג עסק`,
      actorType: "employee",
      actorUserId: session.userId,
    });
  }

  // Always submitted from Step 5 itself — refresh() alone, no redirect().
  refresh();
}
