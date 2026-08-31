"use server";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";
import { requireOwnerSession } from "@/lib/auth/ownerSession";
import { getValidAccessToken } from "@/lib/googleAuth/driveTokens";
import { getDriveFolder } from "@/lib/googleAuth/drive";
import { decryptWhatsAppToken } from "@/lib/whatsapp/tokenCipher";
import { getPhoneNumberInWaba, WhatsAppApiError } from "@/lib/whatsapp/phoneNumbers";
import {
  buildEmbeddedSignupDialogUrl,
  verifyCentroAppSubscribed,
  WHATSAPP_OAUTH_CALLBACK_URI,
} from "@/lib/whatsapp/embeddedSignup";
import { WHATSAPP_HARDCODE_ENABLED, WHATSAPP_HARDCODED } from "@/lib/whatsapp/hardcodedConfig";
import {
  encodeWhatsAppOAuthState,
  WHATSAPP_OAUTH_REDIRECT_URI_COOKIE,
  WHATSAPP_OAUTH_RETURN_TO_COOKIE,
  WHATSAPP_OAUTH_STATE_COOKIE,
} from "@/lib/whatsapp/oauthState";

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

/**
 * Re-runs Embedded Signup for one organization, from the owner console.
 *
 * Needed because there is no way to repair a connection from the product UI:
 * the connect button is hidden once an organization is connected
 * (Step3Connect renders it only when !isConnected), leaving "ניתוק" as the
 * only control — and disconnecting a WABA that is sending fine, to fix
 * receiving, is not an acceptable repair path.
 *
 * The organization is carried in the HMAC-signed OAuth state rather than a
 * query parameter, so it cannot be swapped for another tenant's between here
 * and the callback, and the csrf cookie set below ties the callback to this
 * browser — the one where an authenticated platform owner stood. The owner
 * cookie itself is scoped to /owner and never reaches the callback route,
 * which is why the authorisation has to travel this way.
 *
 * NOTHING is cleared here. The existing credentials keep working throughout;
 * completeWhatsAppSignup only overwrites them after Meta has validated the
 * new ones, so a flow abandoned halfway leaves the working connection intact.
 */
export async function reconnectWhatsAppAction(formData: FormData) {
  await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const db = await getDb();
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!org) redirect("/owner/organizations");

  const appId = WHATSAPP_HARDCODE_ENABLED
    ? WHATSAPP_HARDCODED.appId
    : process.env.NEXT_PUBLIC_WHATSAPP_APP_ID;
  const configId = WHATSAPP_HARDCODE_ENABLED
    ? WHATSAPP_HARDCODED.configId
    : process.env.NEXT_PUBLIC_WHATSAPP_CONFIG_ID;
  if (!appId || !configId) {
    redirect(
      `/owner/organizations/${organizationId}?whatsappError=${encodeURIComponent(
        "חיבור WhatsApp אינו מוגדר בסביבה (App ID / Config ID חסרים)."
      )}#connections`
    );
  }

  const csrf = randomUUID();
  const redirectUri = WHATSAPP_OAUTH_CALLBACK_URI;
  const state = encodeWhatsAppOAuthState({
    csrf,
    returnTo: `/owner/organizations/${organizationId}`,
    redirectUri,
    exp: Date.now() + 10 * 60 * 1000,
    organizationId,
  });

  const cookieStore = await cookies();
  const cookieBase = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  };
  cookieStore.set(WHATSAPP_OAUTH_STATE_COOKIE, csrf, cookieBase);
  cookieStore.set(WHATSAPP_OAUTH_RETURN_TO_COOKIE, `/owner/organizations/${organizationId}`, cookieBase);
  cookieStore.set(WHATSAPP_OAUTH_REDIRECT_URI_COOKIE, redirectUri, cookieBase);

  // rerequest is what makes a REPEAT signup actually offer the account
  // picker. Without it Meta sees the app is already authorised for this
  // Facebook user, shows only "you previously linked Centro AI Messaging —
  // continue as …", and hands back a code carrying the FIRST grant's
  // permissions. The WhatsApp Business Account and phone number are then
  // never selectable, and the token comes back scoped to whatever WABA that
  // earlier signup happened to cover — which is why the reconnect kept
  // failing at phone-lookup against an account nobody chose.
  const dialogUrl = buildEmbeddedSignupDialogUrl({
    appId,
    configId,
    redirectUri,
    state,
    rerequest: true,
  });
  console.log("[whatsapp-oauth] owner reconnect dialog", {
    organizationId,
    appId,
    configId,
    redirectUri,
    rerequest: true,
  });
  redirect(dialogUrl);
}
