"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { clients, organizations } from "@/db/schema";
import { parseClientCsv } from "@/lib/csv";
import { recordAuditEvent } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { markOnboardingComplete } from "@/lib/onboarding";

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

  redirect("/onboarding");
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

export async function activateAutomation() {
  const session = await requireSession();
  const db = await getDb();
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, session.organizationId))
    .limit(1);

  // BR-001 (Ch.3): automation cannot be activated until all mandatory
  // integrations are connected. Enforced here server-side, not just by
  // disabling the button, since this is a real business rule.
  if (!organization?.googleConnectedAt || !organization?.whatsappConnectedAt) {
    redirect("/onboarding?error=integrations-required");
  }

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

  // Activating automation is a clear, unambiguous "setup is done" signal —
  // also mark onboarding complete so this org's next login goes straight to
  // the Dashboard instead of back through this page.
  await markOnboardingComplete(session.organizationId);

  redirect("/dashboard");
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

  redirect("/onboarding");
}

// Explicit exit from this placeholder onboarding flow, independent of
// activateAutomation() above — an org shouldn't be permanently stuck here
// just because it isn't ready to turn automation on yet. This is the seam
// the real onboarding wizard (next epic) will call from its own final step.
export async function finishOnboarding() {
  const session = await requireSession();
  await markOnboardingComplete(session.organizationId);

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "onboarding.completed",
    description: "הקמת המערכת סומנה כהושלמה",
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

export interface ImportClientsState {
  error?: string;
  result?: {
    imported: number;
    skipped: SkippedImportRow[];
  };
}

export async function importClients(
  _prevState: ImportClientsState,
  formData: FormData
): Promise<ImportClientsState> {
  const session = await requireSession();
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return { error: "נא לבחור קובץ CSV." };
  }

  const text = await file.text();
  let parsedRows;
  try {
    parsedRows = parseClientCsv(text);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "שגיאה בקריאת הקובץ." };
  }

  const db = await getDb();
  const existing = await db
    .select({ phone: clients.phone })
    .from(clients)
    .where(eq(clients.organizationId, session.organizationId));
  const existingPhones = new Set(existing.map((c) => c.phone));

  const skipped: SkippedImportRow[] = [];
  let imported = 0;

  for (let i = 0; i < parsedRows.length; i += 1) {
    const row = parsedRows[i];
    const rowNumber = i + 2; // +1 for header, +1 for 1-indexing

    if (!row.name || !row.phone) {
      skipped.push({ row: rowNumber, name: row.name || "—", reason: "חסר שם או טלפון" });
      continue;
    }
    if (existingPhones.has(row.phone)) {
      skipped.push({ row: rowNumber, name: row.name, reason: "מספר טלפון כבר קיים" });
      continue;
    }

    await db.insert(clients).values({
      organizationId: session.organizationId,
      name: row.name,
      phone: row.phone,
      email: row.email || null,
      notes: row.notes || null,
    });
    existingPhones.add(row.phone);
    imported += 1;
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "clients.imported",
    description: `${imported} לקוחות יובאו מקובץ CSV (${skipped.length} דולגו)`,
    actorType: "employee",
    actorUserId: session.userId,
    metadata: { imported, skippedCount: skipped.length },
  });

  return { result: { imported, skipped } };
}
