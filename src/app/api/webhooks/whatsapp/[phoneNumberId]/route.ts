import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";
import { POST as sharedWebhookPost } from "../route";

// Per-phone-number webhook override endpoint (Meta "Webhook overrides").
// A manually-connected organization gets its own callback URL here —
// /api/webhooks/whatsapp/<phoneNumberId> — instead of sharing the
// app-level /api/webhooks/whatsapp with every other tenant. Meta resolves
// an inbound event's destination phone-number override first, then the
// WABA's, then the app default, so an organization WITHOUT an override is
// completely unaffected and keeps using the shared endpoint exactly as
// before.
//
// This route deliberately owns only what genuinely differs per number —
// the GET handshake, which must answer with THIS number's own verify
// token. Everything about handling a real inbound event (signature
// verification against the shared WHATSAPP_APP_SECRET, claiming, routing
// by phone_number_id inside the payload, processing) is identical, so POST
// delegates to the shared handler rather than duplicating it: there is
// exactly one inbound-message code path in the system, and this URL is
// just another door into it.

// Matches the shared route's own ceiling — the delegated handler does the
// real work, including its own after() deferral.
export const maxDuration = 180;

// Meta's one-time handshake, performed against this exact URL at the
// moment the override is set (see setPhoneNumberWebhookOverride). Echoes
// hub.challenge back only if hub.verify_token matches the token stored for
// the organization that owns this phone number id — never the shared
// app-level WHATSAPP_WEBHOOK_VERIFY_TOKEN, so one tenant's token can never
// verify another tenant's endpoint.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ phoneNumberId: string }> }
) {
  const { phoneNumberId } = await params;
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode !== "subscribe" || !challenge || !token) {
    return NextResponse.json({ error: "verification-failed" }, { status: 403 });
  }

  const db = await getDb();
  const [organization] = await db
    .select({ verifyToken: organizations.whatsappWebhookVerifyToken })
    .from(organizations)
    .where(
      and(
        eq(organizations.whatsappPhoneNumberId, phoneNumberId),
        // A null token means no override was ever established for this
        // number; there is nothing here to verify against, and falling
        // back to the shared token would defeat the per-tenant isolation
        // this endpoint exists for.
        eq(organizations.whatsappWebhookVerifyToken, token)
      )
    )
    .limit(1);

  if (!organization) {
    console.error("[whatsapp-webhook] per-number handshake rejected", { phoneNumberId });
    return NextResponse.json({ error: "verification-failed" }, { status: 403 });
  }

  return new NextResponse(challenge, { status: 200 });
}

export async function POST(request: NextRequest) {
  return sharedWebhookPost(request);
}
