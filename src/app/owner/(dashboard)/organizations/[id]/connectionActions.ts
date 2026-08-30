"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";
import { requireOwnerSession } from "@/lib/auth/ownerSession";
import { getValidAccessToken } from "@/lib/googleAuth/driveTokens";
import { getDriveFolder } from "@/lib/googleAuth/drive";
import { decryptWhatsAppToken } from "@/lib/whatsapp/tokenCipher";
import { getPhoneNumberInWaba, WhatsAppApiError } from "@/lib/whatsapp/phoneNumbers";
import { verifyCentroAppSubscribed } from "@/lib/whatsapp/embeddedSignup";

// Real connection checks — both of these make a genuine API call and store
// what actually came back. Neither infers health from "credentials exist",
// which is the difference between a badge and a check.
//
// Both write organizations.*HealthOk/Reason/CheckedAt, which is what makes
// "דורש טיפול" self-clearing: a passing check overwrites a failing one, so
// fixing the underlying problem and re-checking is all it takes.

function backToConnections(organizationId: string): never {
  redirect(`/owner/organizations/${organizationId}#connections`);
}

// Re-verifies the stored WhatsApp credentials against Meta: does the token
// still work, and does it still have access to this exact phone number on
// this exact WABA. A token that expired or lost its permission fails here.
export async function checkWhatsAppConnectionAction(formData: FormData) {
  await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const db = await getDb();
  const [org] = await db
    .select({
      wabaId: organizations.whatsappBusinessAccountId,
      phoneNumberId: organizations.whatsappPhoneNumberId,
      tokenEnc: organizations.whatsappAccessTokenEnc,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  let ok = false;
  let inboundOk = false;
  let reason: string | null = null;

  if (!org?.wabaId || !org.phoneNumberId) {
    reason = "לא הוגדרו פרטי חיבור (WABA / מספר) עבור הארגון הזה.";
  } else if (!org.tokenEnc) {
    // An Embedded Signup organization has no token of its own; the shared
    // system token covers it, and there is nothing per-organization to
    // verify here. Reported honestly rather than as a failure.
    reason = "החיבור בוצע דרך Embedded Signup — אין טוקן ייעודי לארגון לבדיקה.";
  } else {
    // Two independent capabilities, checked separately.
    //
    // This used to verify only that the token could read the phone number on
    // the WABA — which proves OUTBOUND works — and then reported "החיבור
    // תקין". An organization whose WABA is not subscribed to Centro's Meta
    // App receives no inbound messages and no delivery statuses at all, and
    // that state passed as fully healthy. Sending and receiving are separate
    // things and are now reported as such.
    //
    // Both calls are GETs: a health check must never message a client.
    const accessToken = decryptWhatsAppToken(org.tokenEnc);
    let outboundOk = false;
    try {
      await getPhoneNumberInWaba(org.wabaId, org.phoneNumberId, accessToken);
      outboundOk = true;
    } catch (error) {
      reason =
        error instanceof WhatsAppApiError
          ? error.message
          : "בדיקת החיבור מול Meta נכשלה. נסו שוב.";
      console.error("[owner] checkWhatsAppConnection failed", {
        organizationId,
        // Never the token — only Meta's own message, which does not contain it.
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (outboundOk) {
      const subscription = await verifyCentroAppSubscribed(org.wabaId, accessToken);
      inboundOk = subscription.subscribed;
      if (!inboundOk) {
        reason =
          "חיבור חלקי — שליחת הודעות זמינה, קבלת הודעות אינה מחוברת. " +
          "חשבון ה-WhatsApp של הארגון אינו מקושר לאפליקציה של Centro, ולכן הודעות נכנסות " +
          "ועדכוני מסירה לא יגיעו. יש לבצע חיבור מחדש (Connect WhatsApp) כדי להשלים זאת.";
      }
      ok = inboundOk;
    }
  }

  await db
    .update(organizations)
    .set({
      whatsappHealthOk: ok,
      whatsappHealthReason: ok ? null : reason,
      // Readiness to RECEIVE, recorded from what Meta actually reports
      // rather than inferred from the connection existing.
      whatsappWebhookSubscribedAt: inboundOk ? new Date() : null,
      whatsappHealthCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, organizationId));

  backToConnections(organizationId);
}

// Real Drive check: refreshes the stored OAuth token (which fails outright
// if the grant was revoked) and then actually fetches the organization's
// target folder — so a folder that was deleted, moved out of reach, or had
// its sharing removed is caught, not just a missing credential.
export async function checkDriveConnectionAction(formData: FormData) {
  await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const db = await getDb();
  const [org] = await db
    .select({
      connectedAt: organizations.googleConnectedAt,
      folderId: organizations.googleDriveFolderId,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  let ok = false;
  let reason: string | null = null;

  if (!org?.connectedAt) {
    reason = "Google Drive לא חובר עבור הארגון הזה.";
  } else if (!org.folderId) {
    reason = "לא נבחרה תיקיית יעד ב-Google Drive.";
  } else {
    try {
      const accessToken = await getValidAccessToken(organizationId);
      const folder = await getDriveFolder(accessToken, org.folderId);
      if (!folder?.id) {
        reason = "תיקיית היעד לא נמצאה ב-Google Drive.";
      } else {
        ok = true;
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      // Distinguish the two failures an owner can actually act on.
      reason = /invalid_grant|unauthorized|401/i.test(raw)
        ? "ההרשאה ל-Google Drive פגה או בוטלה — יש לחבר מחדש."
        : "לא ניתן לגשת לתיקיית Google Drive. ייתכן שהיא נמחקה או שההרשאה הוסרה.";
      console.error("[owner] checkDriveConnection failed", { organizationId, error: raw });
    }
  }

  await db
    .update(organizations)
    .set({
      googleHealthOk: ok,
      googleHealthReason: ok ? null : reason,
      googleHealthCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, organizationId));

  backToConnections(organizationId);
}
