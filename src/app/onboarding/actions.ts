"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { getDb } from "@/db";
import { clients, organizations, services } from "@/db/schema";
import {
  analyzeImportFileStructure,
  UnsupportedImportFormatError,
  type ImportFileStructure,
} from "@/lib/import/clientImportAdapter";
import {
  analyzeColumnsWithAIFallback,
  type AnalyzeColumnsResult,
  type ColumnMapping,
} from "@/lib/import/columnAnalyzer";
import type { TableBounds } from "@/lib/import/spreadsheetStructure";
import type { XlsxStructureMeta } from "@/lib/import/xlsxParser";
import { buildClientRowsFromMapping } from "@/lib/csv";
import { recordAuditEvent } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { markOnboardingComplete } from "@/lib/onboarding";
import { clampCollectionDay } from "@/lib/businessHours";
import { BUSINESS_CATEGORIES, type BusinessCategory } from "@/lib/businessCategories";
import {
  assignClientsToBusinessType,
  createBusinessType,
  getLearnedSynonyms,
  getSuggestedRequirements,
  seedStarterBusinessTypes,
} from "@/lib/businessTypes";
import {
  AUTO_CLASSIFY_CONFIDENCE as AUTO_CLASSIFY_THRESHOLD,
  classifyClientBusinessType,
  SUGGESTED_CONFIDENCE as SUGGESTED_THRESHOLD,
} from "@/lib/ai/businessTypeClassifier";

// >=95: silently auto-classified. 70-94: auto-classified but flagged
// "suggested" in the UI. Below 70: never applied — left Unclassified and
// routed to Step 5's manual bulk-assignment flow. Centro never guesses.
// (Bands defined once in businessTypeClassifier.ts — Milestone 1 reuses
// the exact same thresholds for manually-created clients.)

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

export interface BusinessCategoryState {
  fieldErrors?: { businessCategory?: string; customLabel?: string };
}

// Step 3 (new).
export async function updateBusinessCategory(
  _prevState: BusinessCategoryState,
  formData: FormData
): Promise<BusinessCategoryState> {
  const session = await requireSession();
  const businessCategory = String(formData.get("businessCategory") ?? "");
  const customLabel = String(formData.get("businessCategoryCustomLabel") ?? "").trim();

  if (!BUSINESS_CATEGORIES.includes(businessCategory as BusinessCategory)) {
    return { fieldErrors: { businessCategory: "נא לבחור סוג עסק." } };
  }
  if (businessCategory === "other" && !customLabel) {
    return { fieldErrors: { customLabel: "נא לפרט את סוג העסק." } };
  }

  const db = await getDb();
  await db
    .update(organizations)
    .set({
      businessCategory,
      businessCategoryCustomLabel: businessCategory === "other" ? customLabel : null,
      onboardingStep: 4,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, session.organizationId));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "organization.business_category_set",
    description: "סוג העסק של המשרד נקבע באשף ההקמה",
    actorType: "employee",
    actorUserId: session.userId,
    metadata: { businessCategory, customLabel: customLabel || undefined },
  });

  redirect("/onboarding?step=4");
}

// Step 4 (new). Bound to the chosen value (`.bind(null, "recurring" |
// "one_time")`), matching this file's existing `advanceOnboardingStep`
// pattern — the choice is a decisive action (two distinct buttons), not a
// selection to confirm separately. Permanent for the pilot: not exposed as
// an editable Settings toggle, since changing it later is a data-migration
// question, not a form field.
export async function updateWorkflowType(value: "recurring" | "one_time") {
  const session = await requireSession();
  const db = await getDb();
  await db
    .update(organizations)
    .set({ workflowType: value, onboardingStep: 5, updatedAt: new Date() })
    .where(eq(organizations.id, session.organizationId));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "organization.workflow_type_set",
    description:
      value === "recurring"
        ? "המשרד בחר באיסוף מסמכים קבוע וחוזר"
        : "המשרד בחר באיסוף מסמכים חד-פעמי",
    actorType: "employee",
    actorUserId: session.userId,
  });

  redirect("/onboarding?step=5");
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
  if (!service) redirect("/onboarding?step=9");

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
        collectionDayOfMonthOverride: null,
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
        collectionDayOfMonthOverride: clampCollectionDay(
          formData.get("collectionDayOfMonth")
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
    notes?: string;
    city?: string;
    companyId?: string;
    taxId?: string;
  };
  imported: number;
  /** Confidence >= 95 — applied silently. */
  autoClassified: number;
  /** Confidence 70-94 — applied, but flagged as a suggestion in the UI. */
  suggested: number;
  /** Confidence < 70, or no signal at all — left Unclassified. */
  needsReview: number;
  // STEP 1 structural findings, XLSX only.
  sheetsFound?: string[];
  sheetUsed?: string;
  hadMergedCells?: boolean;
  hiddenColumnsDetected?: number;
  skippedLeadingRows?: number;
  skippedTrailingRows?: number;
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
    tableBounds: TableBounds;
    xlsxMeta?: XlsxStructureMeta;
    mode: ImportMode;
  };
}

// "add" (the default): append to whatever clients already exist, same
// duplicate-phone skip logic as always — this is the wizard's normal Step
// 4 upload, and Step 5's "Add another Excel file" affordance for when the
// first file was correct but incomplete. "replace": the accountant
// uploaded the wrong file — see importParsedRows for what this actually
// deletes and why it's safe to.
export type ImportMode = "add" | "replace";

function readImportMode(formData: FormData): ImportMode {
  return formData.get("mode") === "replace" ? "replace" : "add";
}

type ParsedClientRow = ReturnType<typeof buildClientRowsFromMapping>[number];

// Shared by both the confident-auto-import path and the confirm-mapping
// path below: inserts new clients (same duplicate-phone handling the
// pre-wizard importer always had, plus the raw business-type text kept on
// the row for STEP 7's learning mechanism), then runs the multi-layer
// classifier (src/lib/ai/businessTypeClassifier.ts) against every newly
// imported client, seeding the five starter Business Types on first use.
// Records one audit event carrying the full understanding summary
// (src/app/onboarding/page.tsx's Step 5 case reads the latest one back to
// render "here's what Centro understood" — requirement 14) plus the
// existing imported/classified events.
async function importParsedRows(
  session: { organizationId: string; userId: string },
  parsedRows: ParsedClientRow[],
  analysis: AnalyzeColumnsResult,
  structure: { tableBounds: TableBounds; xlsxMeta?: XlsxStructureMeta },
  mode: ImportMode = "add"
): Promise<ImportClientsState> {
  const db = await getDb();

  // "Replace Excel file": the accountant uploaded the wrong file. Delete
  // exactly the clients this wizard's own import created — never a
  // pre-existing client, never one added manually — right before
  // inserting the new file's rows, so a cancelled/still-ambiguous mapping
  // never loses data (see confirmImportMapping: nothing is deleted until
  // a real import is actually about to happen). Guarded by
  // onboardingCompletedAt as defense-in-depth: this whole flow only
  // exists in the wizard UI, but a Server Action is reachable by anyone
  // who can POST to it directly, not only through that UI.
  if (mode === "replace") {
    const [organization] = await db
      .select({ onboardingCompletedAt: organizations.onboardingCompletedAt })
      .from(organizations)
      .where(eq(organizations.id, session.organizationId))
      .limit(1);

    if (!organization?.onboardingCompletedAt) {
      const removed = await db
        .delete(clients)
        .where(
          and(
            eq(clients.organizationId, session.organizationId),
            eq(clients.importedDuringOnboarding, true)
          )
        )
        .returning({ id: clients.id });

      if (removed.length > 0) {
        await recordAuditEvent({
          organizationId: session.organizationId,
          eventType: "clients.import_replaced",
          description: `קובץ הייבוא הוחלף — ${removed.length} לקוחות מהייבוא הקודם הוסרו`,
          actorType: "employee",
          actorUserId: session.userId,
          metadata: { removedCount: removed.length },
        });
      }
    }
  }

  const existing = await db
    .select({ phone: clients.phone })
    .from(clients)
    .where(eq(clients.organizationId, session.organizationId));
  const existingPhones = new Set(existing.map((c) => c.phone));

  const skipped: SkippedImportRow[] = [];
  const importedRows: Array<{
    id: string;
    name: string;
    businessType: string;
    otherValues: string[];
  }> = [];

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
        importedBusinessTypeText: row.businessType || null,
        importedDuringOnboarding: true,
      })
      .returning({ id: clients.id, name: clients.name });

    existingPhones.add(row.phone);
    importedRows.push({
      id: inserted.id,
      name: inserted.name,
      businessType: row.businessType,
      otherValues: row.otherValues,
    });
  }

  const detectedColumns: ImportAnalysisSummary["detectedColumns"] = {
    name: analysis.mapping.name !== undefined ? analysis.headers[analysis.mapping.name] : undefined,
    phone: analysis.mapping.phone !== undefined ? analysis.headers[analysis.mapping.phone] : undefined,
    email: analysis.mapping.email !== undefined ? analysis.headers[analysis.mapping.email] : undefined,
    businessType:
      analysis.mapping.businessType !== undefined
        ? analysis.headers[analysis.mapping.businessType]
        : undefined,
    notes: analysis.mapping.notes !== undefined ? analysis.headers[analysis.mapping.notes] : undefined,
    city: analysis.mapping.city !== undefined ? analysis.headers[analysis.mapping.city] : undefined,
    companyId:
      analysis.mapping.companyId !== undefined ? analysis.headers[analysis.mapping.companyId] : undefined,
    taxId: analysis.mapping.taxId !== undefined ? analysis.headers[analysis.mapping.taxId] : undefined,
  };

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "clients.imported",
    description: `${importedRows.length} לקוחות יובאו (${skipped.length} דולגו)`,
    actorType: "employee",
    actorUserId: session.userId,
    metadata: { imported: importedRows.length, skippedCount: skipped.length },
  });

  let autoClassified = 0;
  let suggested = 0;
  if (importedRows.length > 0) {
    const learnedSynonyms = await getLearnedSynonyms(session.organizationId);
    const businessTypeList = await seedStarterBusinessTypes(session.organizationId);
    const candidates = businessTypeList.map((t) => ({
      id: t.id,
      name: t.name,
      canonicalKey: t.canonicalKey,
    }));

    // Grouped by (businessTypeId, confidence) so every client that shares
    // both gets one batched assignClientsToBusinessType call, instead of
    // one DB round-trip per client.
    const groups = new Map<string, { businessTypeId: string; confidence: number; clientIds: string[] }>();

    for (const row of importedRows) {
      const classification = await classifyClientBusinessType(
        { clientName: row.name, explicitBusinessType: row.businessType, otherValues: row.otherValues },
        candidates,
        learnedSynonyms
      );
      if (!classification.businessTypeId || classification.confidence < SUGGESTED_THRESHOLD) continue;

      if (classification.confidence >= AUTO_CLASSIFY_THRESHOLD) autoClassified += 1;
      else suggested += 1;

      const key = `${classification.businessTypeId}:${classification.confidence}`;
      const group = groups.get(key) ?? {
        businessTypeId: classification.businessTypeId,
        confidence: classification.confidence,
        clientIds: [],
      };
      group.clientIds.push(row.id);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      await assignClientsToBusinessType(session.organizationId, group.clientIds, group.businessTypeId, {
        confidence: group.confidence,
      });
    }

    await recordAuditEvent({
      organizationId: session.organizationId,
      eventType: "clients.classified",
      description: `${autoClassified + suggested} מתוך ${importedRows.length} לקוחות שיובאו סווגו אוטומטית לפי סוג עסק`,
      actorType: "ai",
      metadata: {
        autoClassified,
        suggested,
        unclassified: importedRows.length - autoClassified - suggested,
      },
    });
  }

  const needsReview = importedRows.length - autoClassified - suggested;

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "clients.import_analyzed",
    description: "Centro ניתח את מבנה הקובץ שיובא",
    actorType: "ai",
    metadata: {
      confidence: analysis.confidence,
      detectedColumns,
      imported: importedRows.length,
      autoClassified,
      suggested,
      needsReview,
      sheetsFound: structure.xlsxMeta?.sheetNames,
      sheetUsed: structure.xlsxMeta?.sheetUsed,
      hadMergedCells: structure.xlsxMeta?.hadMergedCells,
      hiddenColumnsDetected: structure.xlsxMeta?.hiddenColumnIndexes.length,
      skippedLeadingRows: structure.tableBounds.skippedLeadingRows,
      skippedTrailingRows: structure.tableBounds.skippedTrailingRows,
    } satisfies ImportAnalysisSummary,
  });

  await setOnboardingStep(session.organizationId, 7);
  redirect("/onboarding?step=7");
}

// Step 4 ("Import Excel / CSV") + Step 5 ("AI Client Analysis") in one
// action. STEP 1: parses the file and resolves its real structure — which
// worksheet holds the data, where the table actually starts/ends
// (src/lib/import/clientImportAdapter.ts's analyzeImportFileStructure).
// STEP 2: runs the trimmed grid through the content-based column analyzer
// (src/lib/import/columnAnalyzer.ts), which infers every column's role
// from the *values*, not just header text — real office files rename,
// reorder, or omit headers entirely. When the analyzer is confident, the
// import proceeds automatically; when it isn't, this returns
// `needsMapping` instead of importing anything, and confirmImportMapping
// below finishes the job once the user confirms or corrects the mapping.
export async function importAndClassifyClients(
  _prevState: ImportClientsState,
  formData: FormData
): Promise<ImportClientsState> {
  const session = await requireSession();
  const file = formData.get("file");
  const mode = readImportMode(formData);

  if (!(file instanceof File) || file.size === 0) {
    return { error: "נא לבחור קובץ להעלאה." };
  }

  let structure: ImportFileStructure;
  try {
    structure = await analyzeImportFileStructure(file);
  } catch (error) {
    if (error instanceof UnsupportedImportFormatError) {
      return { error: error.message };
    }
    return { error: error instanceof Error ? error.message : "שגיאה בקריאת הקובץ." };
  }

  const rawRows = structure.rows;
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
        tableBounds: structure.tableBounds,
        xlsxMeta: structure.xlsxMeta,
        mode,
      },
    };
  }

  const dataRows = analysis.hasHeaderRow ? rawRows.slice(1) : rawRows;
  const parsedRows = buildClientRowsFromMapping(dataRows, analysis.mapping);
  return importParsedRows(
    session,
    parsedRows,
    analysis,
    { tableBounds: structure.tableBounds, xlsxMeta: structure.xlsxMeta },
    mode
  );
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
  const mode = readImportMode(formData);

  let rows: string[][];
  try {
    rows = JSON.parse(String(formData.get("rows") ?? "[]"));
  } catch {
    return { error: "אירעה שגיאה בטעינת הקובץ מחדש. נא להעלות אותו שוב." };
  }
  const hasHeaderRow = formData.get("hasHeaderRow") === "1";
  let xlsxMeta: XlsxStructureMeta | undefined;
  try {
    const raw = formData.get("xlsxMeta");
    xlsxMeta = raw ? JSON.parse(String(raw)) : undefined;
  } catch {
    xlsxMeta = undefined;
  }
  const skippedLeadingRows = Number(formData.get("skippedLeadingRows") ?? 0);
  const skippedTrailingRows = Number(formData.get("skippedTrailingRows") ?? 0);

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

  return importParsedRows(
    session,
    parsedRows,
    { hasHeaderRow, headers, columns: [], mapping, confidence: "high" },
    {
      tableBounds: {
        startIndex: 0,
        endIndex: rows.length - 1,
        skippedLeadingRows,
        skippedTrailingRows,
      },
      xlsxMeta,
    },
    mode
  );
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

// UX refinement: move an *already-classified* client to a different
// Business Type — assignBusinessTypeAction above only ever targets
// unclassified clients. A manual reassignment is exactly as certain as a
// manual first assignment (assignClientsToBusinessType defaults
// `confidence` to 100 either way), so this simply reuses it. Org-scoped
// internally (assignClientsToBusinessType's update filters by
// organizationId), so an unscoped clientId here can't touch another
// organization's client.
export async function reassignClientBusinessType(formData: FormData) {
  const session = await requireSession();
  const clientId = String(formData.get("clientId") ?? "");
  const businessTypeId = String(formData.get("businessTypeId") ?? "");
  if (!clientId || !businessTypeId) {
    refresh();
    return;
  }

  await assignClientsToBusinessType(session.organizationId, [clientId], businessTypeId);

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "clients.business_type_reassigned",
    description: "סיווג סוג העסק של לקוח שונה ידנית",
    actorType: "employee",
    actorUserId: session.userId,
    clientId,
  });

  // Always submitted from Step 5 itself — refresh() alone, no redirect().
  refresh();
}

// Product Evolution M3 — Workflow B's own Step 6 ("Optional Client
// Import"). Deliberately not importAndClassifyClients: per spec, a
// one-time-workflow import stores only name and phone, "nothing else" —
// no business-type classification, no learned-synonym writes, no
// business_types/services seeding, no "here's what Centro understood"
// analysis summary. Reuses the same structure/column-detection engine as
// the recurring import (so real, messy office files still work) purely to
// locate the name/phone columns — never to classify anything.
export interface OneTimeImportState {
  error?: string;
  result?: { imported: number; skipped: number };
}

export async function importClientsSimple(
  _prevState: OneTimeImportState,
  formData: FormData
): Promise<OneTimeImportState> {
  const session = await requireSession();
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return { error: "נא לבחור קובץ להעלאה." };
  }

  let structure: ImportFileStructure;
  try {
    structure = await analyzeImportFileStructure(file);
  } catch (error) {
    if (error instanceof UnsupportedImportFormatError) {
      return { error: error.message };
    }
    return { error: error instanceof Error ? error.message : "שגיאה בקריאת הקובץ." };
  }

  const rawRows = structure.rows;
  const analysis = await analyzeColumnsWithAIFallback(rawRows);
  if (analysis.mapping.name === undefined || analysis.mapping.phone === undefined) {
    return {
      error: "לא הצלחנו לזהות עמודות שם וטלפון בקובץ. ודאו שהקובץ כולל את הפרטים האלה ונסו שוב.",
    };
  }

  const dataRows = analysis.hasHeaderRow ? rawRows.slice(1) : rawRows;
  const parsedRows = buildClientRowsFromMapping(dataRows, analysis.mapping);

  const db = await getDb();
  const existing = await db
    .select({ phone: clients.phone })
    .from(clients)
    .where(eq(clients.organizationId, session.organizationId));
  const existingPhones = new Set(existing.map((c) => c.phone));

  let imported = 0;
  let skipped = 0;
  for (const row of parsedRows) {
    if (!row.name || !row.phone || existingPhones.has(row.phone)) {
      skipped += 1;
      continue;
    }
    // Name and phone only — no email/notes, no importedBusinessTypeText,
    // no importedDuringOnboarding (that flag exists solely for the
    // recurring wizard's "Replace Excel file" feature, which Workflow B
    // doesn't have).
    await db.insert(clients).values({
      organizationId: session.organizationId,
      name: row.name,
      phone: row.phone,
    });
    existingPhones.add(row.phone);
    imported += 1;
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "clients.imported",
    description: `${imported} לקוחות יובאו (${skipped} דולגו) — ללא סיווג, בהתאם לתהליך העבודה החד-פעמי`,
    actorType: "employee",
    actorUserId: session.userId,
    metadata: { imported, skipped },
  });

  await setOnboardingStep(session.organizationId, 7);
  redirect("/onboarding?step=7");
}

// Workflow B's own Step 7 ("Working Hours"). Unlike the recurring path's
// Reminder Rules step, this asks only business days/hours — never
// reminder interval, inactivity timeout, or collection-day-of-month,
// which are recurring-cadence concepts that don't apply to a one-off
// request. These org-wide fields already have sensible defaults
// (organizations.reminderIntervalDays etc.), so the shared scheduler
// engine works unchanged for a one-time org even though its onboarding
// never asks about them.
export async function updateWorkingHours(formData: FormData) {
  const session = await requireSession();
  const businessHoursStart = String(formData.get("businessHoursStart") ?? "09:00");
  const businessHoursEnd = String(formData.get("businessHoursEnd") ?? "18:00");
  const businessDays = WEEKDAYS.filter((day) => formData.get(`day-${day}`) === "on").join(",");

  const db = await getDb();
  await db
    .update(organizations)
    .set({
      businessHoursStart,
      businessHoursEnd,
      businessDays: businessDays || "0,1,2,3,4",
      onboardingStep: 8,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, session.organizationId));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "configuration.updated",
    description: "שעות ופעילות המשרד הוגדרו באשף ההקמה (תהליך עבודה חד-פעמי)",
    actorType: "employee",
    actorUserId: session.userId,
  });

  redirect("/onboarding?step=8");
}
