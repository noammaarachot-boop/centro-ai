import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";
import { GRAPH_API_BASE, getWhatsAppConfig } from "./config";
import { resolveOrganizationWhatsAppConfig } from "./organizationWhatsApp";
import { subscribeToWabaWebhooks } from "./embeddedSignup";
import { setPhoneNumberWebhookOverride } from "./phoneNumbers";
import { buildPhoneNumberWebhookUrl } from "./webhookUrls";

/**
 * Why is this office receiving no inbound WhatsApp messages?
 *
 * Answering that needs three facts that only Meta holds, and reading them
 * needs the organization's OWN token — which lives encrypted in the
 * database and is only decryptable in the deployed environment. There was
 * no way to ask from outside, so "Meta never delivered" and "we dropped it"
 * were indistinguishable.
 *
 * Read-only by default. `repair` re-runs the two registrations Meta needs,
 * both of which are idempotent.
 */
export interface InboundDiagnosis {
  organizationId: string;
  organizationName: string;
  wabaId: string | null;
  phoneNumberId: string;
  tokenSource: string;
  /** Which Meta app issued the token — decides which app a subscribe call attaches. */
  tokenIssuedByApp: unknown;
  /** Whether this WABA is subscribed to Centro's app — the inbound switch. */
  wabaSubscribedApps: unknown;
  /** Per-number override, if any. Absent means the app-level URL is used. */
  phoneWebhookConfiguration: unknown;
  expectedOverrideUrl: string;
  repaired?: { wabaSubscribed: boolean; overrideSet: boolean };
  errors: string[];
}

async function graphGet(path: string, accessToken: string, fields?: string) {
  const url = new URL(`${GRAPH_API_BASE}${path}`);
  if (fields) url.searchParams.set("fields", fields);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => null);
  return { httpStatus: res.status, body };
}

export async function diagnoseInbound(
  organizationId: string,
  options?: { repair?: boolean }
): Promise<InboundDiagnosis | { error: string }> {
  const db = await getDb();
  const [org] = await db
    .select({ name: organizations.name, verifyToken: organizations.whatsappWebhookVerifyToken })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!org) return { error: "organization not found" };

  const resolved = await resolveOrganizationWhatsAppConfig(organizationId);
  if (!resolved.ok) return { error: resolved.reason };
  const { wabaId, phoneNumberId, accessToken, tokenSource } = resolved.config;

  const errors: string[] = [];
  // Never logged or returned: only structured Meta responses leave here.
  const token = accessToken ?? "";
  if (!token) errors.push("no usable access token for this organization");

  const subscribed = wabaId
    ? await graphGet(`/${encodeURIComponent(wabaId)}/subscribed_apps`, token).catch((e) => ({
        httpStatus: 0,
        body: { error: String(e) },
      }))
    : { httpStatus: 0, body: { error: "no wabaId on this organization" } };

  const phoneCfg = await graphGet(
    `/${encodeURIComponent(phoneNumberId)}`,
    token,
    "id,display_phone_number,webhook_configuration"
  ).catch((e) => ({ httpStatus: 0, body: { error: String(e) } }));

  // WHICH Meta app issued this organization's token.
  //
  // Subscribing an app to a WABA means POSTing /{waba}/subscribed_apps with
  // a token issued FOR that app — the call subscribes the token's own app,
  // not one named in the request. So a token minted in the client's own
  // Business Manager subscribes THAT app, and Centro's app is left
  // unsubscribed no matter how many times the call succeeds. This reports
  // the issuing app id so that can be seen rather than inferred.
  let tokenAppId: unknown = null;
  try {
    const { appId, appSecret } = getWhatsAppConfig();
    const url = new URL(`${GRAPH_API_BASE}/debug_token`);
    url.searchParams.set("input_token", token);
    url.searchParams.set("access_token", `${appId}|${appSecret}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const parsed = (await res.json().catch(() => null)) as {
      data?: { app_id?: string; application?: string; type?: string; is_valid?: boolean };
      error?: unknown;
    } | null;
    tokenAppId = {
      httpStatus: res.status,
      centroAppId: appId,
      tokenAppId: parsed?.data?.app_id ?? null,
      application: parsed?.data?.application ?? null,
      type: parsed?.data?.type ?? null,
      isValid: parsed?.data?.is_valid ?? null,
      matchesCentroApp: parsed?.data?.app_id === appId,
      error: parsed?.error ?? null,
    };
  } catch (error) {
    tokenAppId = { error: error instanceof Error ? error.message : String(error) };
  }

  const diagnosis: InboundDiagnosis = {
    organizationId,
    organizationName: org.name,
    tokenIssuedByApp: tokenAppId,
    wabaId,
    phoneNumberId,
    tokenSource,
    wabaSubscribedApps: subscribed,
    phoneWebhookConfiguration: phoneCfg,
    expectedOverrideUrl: buildPhoneNumberWebhookUrl(phoneNumberId),
    errors,
  };

  if (options?.repair && wabaId) {
    // Both calls are idempotent: subscribing an already-subscribed WABA and
    // re-setting an identical override are both no-ops at Meta.
    let wabaSubscribed = false;
    try {
      wabaSubscribed = await subscribeToWabaWebhooks(wabaId, token, {
        allowSharedTokenFallback: false,
      });
    } catch (error) {
      errors.push(`subscribeToWabaWebhooks: ${error instanceof Error ? error.message : String(error)}`);
    }

    let overrideSet = false;
    if (org.verifyToken) {
      try {
        overrideSet = await setPhoneNumberWebhookOverride(
          phoneNumberId,
          buildPhoneNumberWebhookUrl(phoneNumberId),
          org.verifyToken,
          token
        );
        if (overrideSet) {
          await db
            .update(organizations)
            .set({ whatsappWebhookOverrideAt: new Date(), updatedAt: new Date() })
            .where(eq(organizations.id, organizationId));
        }
      } catch (error) {
        errors.push(`setPhoneNumberWebhookOverride: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      errors.push("organization has no stored webhook verify token — cannot set a per-number override");
    }

    diagnosis.repaired = { wabaSubscribed, overrideSet };
  }

  return diagnosis;
}
