"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";
import { requireOwnerSession } from "@/lib/auth/ownerSession";
import { recordOwnerAuditEvent } from "@/lib/owner/audit";
import { subscribeToWabaWebhooks, verifyCentroAppSubscribed } from "@/lib/whatsapp/embeddedSignup";
import {
  getPhoneNumberInWaba,
  describeTokenApp,
  setPhoneNumberWebhookOverride,
  WhatsAppApiError,
  type PhoneNumberDetails,
} from "@/lib/whatsapp/phoneNumbers";
import { ensureTemplatesProvisioned } from "@/lib/whatsapp/templates";
import { buildPhoneNumberWebhookUrl, generateWebhookVerifyToken } from "@/lib/whatsapp/webhookUrls";
import { recordWebhookSubscriptionState, storeWabaConnection, WhatsAppConnectionConflictError } from "@/lib/whatsapp/wabaTokens";

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
  // The token must have been issued by CENTRO's Meta app. Subscribing a WABA
  // attaches the app that issued the token, so a token minted in the client's
  // own Business Manager subscribes THAT app — Meta then delivers the
  // client's inbound messages there and Centro receives nothing, while every
  // call below still reports success. Outbound keeps working throughout
  // (sending only needs a token authorised on the phone number), which is
  // what made this so hard to see: an office sent reminders perfectly for
  // days while every reply vanished.
  const tokenApp = await describeTokenApp(accessToken);
  if (!tokenApp.matchesCentroApp) {
    console.error("[owner] manuallyConnectWhatsApp token belongs to another Meta app", {
      organizationId,
      wabaId,
      phoneNumberId,
      tokenAppId: tokenApp.tokenAppId,
      error: tokenApp.error,
    });
    redirect(
      `/owner/organizations/${organizationId}?whatsappError=${encodeURIComponent(
        "ה-Access Token הונפק על ידי אפליקציית Meta אחרת ולא על ידי האפליקציה של Centro. " +
          "עם טוקן כזה הודעות יוצאות אמנם יישלחו, אבל הודעות נכנסות מהלקוח יגיעו לאפליקציה האחרת " +
          "ו-Centro לא יקבל אותן לעולם. יש להנפיק טוקן מתוך האפליקציה של Centro (Embedded Signup, " +
          "או System User באפליקציה של Centro עם הרשאה ל-WABA הזה)."
      )}`
    );
  }

  let webhooksOk: boolean;
  try {
    // No shared-token fallback here: this organization has its own
    // credentials, so a failure must surface as a real permissions problem
    // now, rather than being masked by the shared token and resurfacing
    // later as an unexplained send failure.
    const posted = await subscribeToWabaWebhooks(wabaId, accessToken, {
      allowSharedTokenFallback: false,
    });
    // Read it back. The POST subscribes whichever app issued the token, so
    // it can return success while Centro's app is never attached — the WABA
    // stays the organization's either way, but without Centro's app on it
    // Meta delivers this office's inbound messages somewhere else.
    const verification = await verifyCentroAppSubscribed(wabaId, accessToken);
    if (posted && !verification.subscribed) {
      console.error("[owner] manuallyConnectWhatsApp: subscribe reported ok but Centro's app is not attached", {
        organizationId,
        wabaId,
        subscribedAppIds: verification.subscribedAppIds,
        error: verification.error,
      });
    }
    webhooksOk = posted && verification.subscribed;
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

  // Generated (and persisted, just below) BEFORE the override is
  // registered with Meta: Meta GET-handshakes the override URL during that
  // call, and the dynamic route answers that handshake by looking this
  // token up by phoneNumberId. Registering first would guarantee a failed
  // handshake.
  const webhookVerifyToken = generateWebhookVerifyToken();

  try {
    await recordWebhookSubscriptionState(organizationId, webhooksOk);
    await storeWabaConnection(organizationId, {
      businessAccountId: wabaId,
      phoneNumberId,
      displayPhoneNumber: verified.displayPhoneNumber,
      verifiedName: verified.verifiedName,
      accessToken,
      webhookVerifyToken,
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

  // Deliberately NOT fatal, unlike the WABA subscription above: without an
  // override this number's messages still arrive on the shared app-level
  // endpoint (Meta falls back to it), so the connection is fully working
  // either way.
  //
  // The generated URL/token pair is kept regardless of the outcome — the
  // dynamic route honours it either way, so the owner can always see and
  // copy it, and register the override by hand in Meta if this automatic
  // attempt didn't go through. Only whatsappWebhookOverrideAt records
  // whether Meta itself is actually routing there yet, so the screen can
  // say so honestly instead of showing nothing at all.
  const overrideOk = await setPhoneNumberWebhookOverride(
    phoneNumberId,
    buildPhoneNumberWebhookUrl(phoneNumberId),
    webhookVerifyToken,
    accessToken
  );
  const db = await getDb();
  await db
    .update(organizations)
    .set({ whatsappWebhookOverrideAt: overrideOk ? new Date() : null, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId));

  // The live send path sends templates BY NAME (centro_initial_request and
  // friends — see conversationOrchestration.ts / scheduler.ts), and Meta
  // approves a template per-WABA. Without this, a manually-connected
  // office's WABA simply wouldn't have those templates, and the first real
  // send would fail with no obvious cause. Embedded Signup already does
  // this at the equivalent point (completeSignup.ts); the difference is
  // the token — this organization's own, since the shared one has no
  // access to its WABA at all.
  //
  // Best-effort and idempotent (it lists first and only submits what's
  // missing), exactly as in completeSignup: a template that can't be
  // provisioned right now must never undo an otherwise-good connection.
  try {
    await ensureTemplatesProvisioned(wabaId, undefined, accessToken);
  } catch (error) {
    console.error("[owner] manuallyConnectWhatsApp template provisioning failed (non-fatal)", {
      organizationId,
      wabaId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await recordOwnerAuditEvent({
    eventType: "owner.whatsapp_manually_connected",
    description: `WhatsApp חובר ידנית (${verified.displayPhoneNumber}) על ידי ${session.email}`,
    severity: "info",
    platformOwnerId: session.platformOwnerId,
    metadata: { organizationId, wabaId, phoneNumberId, webhooksSubscribed: true, webhookOverride: overrideOk },
  });

  // The override's own outcome is persisted (whatsappWebhookOverrideAt) and
  // rendered from there, so it survives a refresh instead of living in a
  // one-shot query param.
  redirect(`/owner/organizations/${organizationId}?whatsappConnected=1`);
}
