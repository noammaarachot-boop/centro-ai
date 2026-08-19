"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";
import { requireOwnerSession } from "@/lib/auth/ownerSession";
import { recordOwnerAuditEvent } from "@/lib/owner/audit";
import { subscribeToWabaWebhooks } from "@/lib/whatsapp/embeddedSignup";
import { getPhoneNumberInWaba, WhatsAppApiError, type PhoneNumberDetails } from "@/lib/whatsapp/phoneNumbers";
import { storeWabaConnection, WhatsAppConnectionConflictError } from "@/lib/whatsapp/wabaTokens";

// A layout only protects the pages it wraps, not the Server Actions
// those pages invoke — each action here independently calls
// requireOwnerSession(), same convention as every other owner action.
export async function suspendOrganizationAction(formData: FormData) {
  const session = await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const db = await getDb();
  const [org] = await db
    .update(organizations)
    .set({ suspendedAt: new Date(), updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning({ id: organizations.id, name: organizations.name });

  if (org) {
    await recordOwnerAuditEvent({
      eventType: "owner.organization_suspended",
      description: `הארגון "${org.name}" הושעה על ידי ${session.email}`,
      severity: "warning",
      platformOwnerId: session.platformOwnerId,
      metadata: { organizationId: org.id },
    });
  }

  redirect(`/owner/organizations/${organizationId}`);
}

export async function reactivateOrganizationAction(formData: FormData) {
  const session = await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const db = await getDb();
  const [org] = await db
    .update(organizations)
    .set({ suspendedAt: null, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning({ id: organizations.id, name: organizations.name });

  if (org) {
    await recordOwnerAuditEvent({
      eventType: "owner.organization_reactivated",
      description: `הארגון "${org.name}" הופעל מחדש על ידי ${session.email}`,
      severity: "info",
      platformOwnerId: session.platformOwnerId,
      metadata: { organizationId: org.id },
    });
  }

  redirect(`/owner/organizations/${organizationId}`);
}

// Internal QA Mode — lets one marked organization finish onboarding
// without a real WhatsApp connection (Google Drive is never bypassed),
// for manual testing while Meta's WhatsApp app-review is pending. Called
// from the organizations list page's own small toggle
// (src/app/owner/(dashboard)/organizations/page.tsx), same
// requireOwnerSession() + recordOwnerAuditEvent() convention as
// suspend/reactivate above. The actual bypass is enforced server-side in
// finishOnboarding (src/app/onboarding/actions.ts), which re-reads this
// flag from the authenticated session/DB itself — this action only ever
// flips the flag, it never grants access on its own.
export async function enableQaModeAction(formData: FormData) {
  const session = await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const db = await getDb();
  const [org] = await db
    .update(organizations)
    .set({ qaModeEnabledAt: new Date(), updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning({ id: organizations.id, name: organizations.name });

  if (org) {
    await recordOwnerAuditEvent({
      eventType: "owner.qa_mode_enabled",
      description: `מצב בדיקה הופעל עבור "${org.name}" על ידי ${session.email}`,
      severity: "info",
      platformOwnerId: session.platformOwnerId,
      metadata: { organizationId: org.id },
    });
  }

  redirect("/owner/organizations");
}

export async function disableQaModeAction(formData: FormData) {
  const session = await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const db = await getDb();
  const [org] = await db
    .update(organizations)
    .set({ qaModeEnabledAt: null, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning({ id: organizations.id, name: organizations.name });

  if (org) {
    await recordOwnerAuditEvent({
      eventType: "owner.qa_mode_disabled",
      description: `מצב בדיקה בוטל עבור "${org.name}" על ידי ${session.email}`,
      severity: "info",
      platformOwnerId: session.platformOwnerId,
      metadata: { organizationId: org.id },
    });
  }

  redirect("/owner/organizations");
}

// Per-organization Meta template-approval tracking (Phase 2.1 remediation
// — see organizations.initialRequestV2Approved/reminderV2Approved's own
// schema doc comment for the full rationale: Meta approves a message
// template per-WABA, never globally, so this can only ever be set
// correctly by a human who has actually confirmed APPROVED status for
// THIS organization's own WhatsApp Business Account in Meta Business
// Manager — never inferred or set automatically. Same
// requireOwnerSession() + recordOwnerAuditEvent() convention as every
// other action in this file.
export async function enableInitialRequestV2Action(formData: FormData) {
  const session = await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const db = await getDb();
  const [org] = await db
    .update(organizations)
    .set({ initialRequestV2Approved: true, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning({ id: organizations.id, name: organizations.name });

  if (org) {
    await recordOwnerAuditEvent({
      eventType: "owner.initial_request_v2_approved",
      description: `תבנית הפנייה הראשונית (v2) סומנה כמאושרת עבור "${org.name}" על ידי ${session.email}`,
      severity: "info",
      platformOwnerId: session.platformOwnerId,
      metadata: { organizationId: org.id },
    });
  }

  redirect("/owner/organizations");
}

export async function disableInitialRequestV2Action(formData: FormData) {
  const session = await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const db = await getDb();
  const [org] = await db
    .update(organizations)
    .set({ initialRequestV2Approved: false, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning({ id: organizations.id, name: organizations.name });

  if (org) {
    await recordOwnerAuditEvent({
      eventType: "owner.initial_request_v2_unapproved",
      description: `סימון האישור לתבנית הפנייה הראשונית (v2) בוטל עבור "${org.name}" על ידי ${session.email}`,
      severity: "info",
      platformOwnerId: session.platformOwnerId,
      metadata: { organizationId: org.id },
    });
  }

  redirect("/owner/organizations");
}

export async function enableReminderV2Action(formData: FormData) {
  const session = await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const db = await getDb();
  const [org] = await db
    .update(organizations)
    .set({ reminderV2Approved: true, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning({ id: organizations.id, name: organizations.name });

  if (org) {
    await recordOwnerAuditEvent({
      eventType: "owner.reminder_v2_approved",
      description: `תבנית התזכורת (v2) סומנה כמאושרת עבור "${org.name}" על ידי ${session.email}`,
      severity: "info",
      platformOwnerId: session.platformOwnerId,
      metadata: { organizationId: org.id },
    });
  }

  redirect("/owner/organizations");
}

export async function disableReminderV2Action(formData: FormData) {
  const session = await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const db = await getDb();
  const [org] = await db
    .update(organizations)
    .set({ reminderV2Approved: false, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning({ id: organizations.id, name: organizations.name });

  if (org) {
    await recordOwnerAuditEvent({
      eventType: "owner.reminder_v2_unapproved",
      description: `סימון האישור לתבנית התזכורת (v2) בוטל עבור "${org.name}" על ידי ${session.email}`,
      severity: "info",
      platformOwnerId: session.platformOwnerId,
      metadata: { organizationId: org.id },
    });
  }

  redirect("/owner/organizations");
}

// Manual per-organization WhatsApp connection ("חיבור WhatsApp ידני",
// owner-only) — an office that set up its own WhatsApp Cloud API access
// outside Embedded Signup and gave Centro's owner its own Access Token,
// WABA ID, and Phone Number ID. "בדוק וחבר": verifies, with a real Meta
// call (getPhoneNumberInWaba), that the token genuinely has access to the
// given WABA AND that the given phone number actually belongs to it —
// BEFORE anything is written. A failed verification never reaches
// storeWabaConnection, so this organization's existing WhatsApp state (if
// any — including an Embedded-Signup connection) is left completely
// untouched. The token itself is never included in an error message, a
// redirect URL, or an audit log entry — only organizationId/wabaId/
// phoneNumberId/the real display name Meta returned.
export async function manuallyConnectWhatsAppAction(formData: FormData) {
  const session = await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const wabaId = String(formData.get("wabaId") ?? "").trim();
  const phoneNumberId = String(formData.get("phoneNumberId") ?? "").trim();
  const accessToken = String(formData.get("accessToken") ?? "").trim();

  if (!wabaId || !phoneNumberId || !accessToken) {
    redirect(
      `/owner/organizations/${organizationId}?whatsappError=${encodeURIComponent("יש למלא WABA ID, Phone Number ID וטוקן.")}`
    );
  }

  let verified: PhoneNumberDetails;
  try {
    verified = await getPhoneNumberInWaba(wabaId, phoneNumberId, accessToken);
  } catch (error) {
    const message =
      error instanceof WhatsAppApiError ? error.message : "בדיקת החיבור מול Meta נכשלה. נסו שוב.";
    console.error("[owner] manuallyConnectWhatsApp verification failed", {
      organizationId,
      wabaId,
      phoneNumberId,
      error: error instanceof Error ? error.message : String(error),
    });
    redirect(`/owner/organizations/${organizationId}?whatsappError=${encodeURIComponent(message)}`);
  }

  // Manual connections skip Embedded Signup entirely, so nothing else ever
  // calls subscribeToWabaWebhooks for this WABA — without this, a
  // successfully-verified token would still receive zero inbound messages
  // (see that function's own doc comment on this exact Meta behavior: the
  // WABA-level link is a separate subscription from owning/verifying the
  // number). Required here, not best-effort like completeSignup.ts's use of
  // it — a failed subscription must not leave the owner believing the
  // connection is live when messages will actually never arrive, so nothing
  // is saved unless this also succeeds.
  let webhooksOk: boolean;
  try {
    webhooksOk = await subscribeToWabaWebhooks(wabaId, accessToken);
  } catch (error) {
    console.error("[owner] manuallyConnectWhatsApp webhook subscription threw", {
      organizationId,
      wabaId,
      phoneNumberId,
      error: error instanceof Error ? error.message : String(error),
    });
    redirect(
      `/owner/organizations/${organizationId}?whatsappError=${encodeURIComponent(
        "המנוי ל-Webhook מול Meta נכשל (שגיאת תקשורת). החיבור לא נשמר; נסו שוב."
      )}`
    );
  }
  if (!webhooksOk) {
    console.error("[owner] manuallyConnectWhatsApp webhook subscription failed", {
      organizationId,
      wabaId,
      phoneNumberId,
    });
    redirect(
      `/owner/organizations/${organizationId}?whatsappError=${encodeURIComponent(
        'האימות מול Meta הצליח, אך המנוי ל-Webhook נכשל — ודאו שלטוקן יש הרשאת whatsapp_business_management ושה-App "Centro AI Messaging" משויך ל-WABA. החיבור לא נשמר; נסו שוב.'
      )}`
    );
  }

  try {
    await storeWabaConnection(organizationId, {
      businessAccountId: wabaId,
      phoneNumberId,
      displayPhoneNumber: verified.displayPhoneNumber,
      verifiedName: verified.verifiedName,
      accessToken,
    });
  } catch (error) {
    const message =
      error instanceof WhatsAppConnectionConflictError ? error.message : "שמירת החיבור נכשלה. נסו שוב.";
    console.error("[owner] manuallyConnectWhatsApp store failed", {
      organizationId,
      wabaId,
      phoneNumberId,
      error: error instanceof Error ? error.message : String(error),
    });
    redirect(`/owner/organizations/${organizationId}?whatsappError=${encodeURIComponent(message)}`);
  }

  await recordOwnerAuditEvent({
    eventType: "owner.whatsapp_manually_connected",
    description: `WhatsApp חובר ידנית (${verified.displayPhoneNumber}) על ידי ${session.email}`,
    severity: "info",
    platformOwnerId: session.platformOwnerId,
    metadata: { organizationId, wabaId, phoneNumberId, webhooksSubscribed: true },
  });

  redirect(`/owner/organizations/${organizationId}?whatsappConnected=1`);
}
