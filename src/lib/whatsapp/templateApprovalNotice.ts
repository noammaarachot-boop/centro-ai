import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { organizations, users, whatsappTemplates } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { sendTransactionalEmail } from "@/lib/email/mailer";
import {
  renderTemplatesApprovedEmail,
  TEMPLATES_APPROVED_SUBJECT,
} from "@/lib/email/templatesApprovedEmail";
import { getWhatsAppConfig } from "./config";
import { decryptWhatsAppToken } from "./tokenCipher";
import { fetchTemplateStatuses, MANAGED_TEMPLATES } from "./templateManagement";

// "Your templates are approved" — the single place that decides whether an
// organization has reached that state and, if so, tells its owner once.
//
// Both entry points (the owner's manual "רענן סטטוס מול Meta" and the cron
// pass) call syncTemplatesAndNotify, so there is exactly one definition of
// "approved" and one notification mechanism — never two that can drift.
//
// Meta is the source of truth throughout: eligibility is decided from what
// fetchTemplateStatuses actually returns, never from the local table.

export interface TemplateSyncResult {
  /** How many managed templates Meta reported for this WABA. */
  synced: number;
  /** True when every managed template is APPROVED on Meta right now. */
  allApproved: boolean;
  /** True only when THIS call actually delivered the email. */
  emailSent: boolean;
  /** Set when the email was attempted and failed — never fails the sync. */
  emailError: string | null;
}

interface WhatsAppCredentials {
  wabaId: string;
  accessToken: string;
}

// THIS organization's WABA, paired with whichever token is authorised for
// it: the office's own for a manual connection, Centro's Tech Provider
// System User for an Embedded Signup one. The wabaId always comes from this
// organization's row, so no token is ever pointed at another tenant's
// account.
async function resolveCredentials(organizationId: string): Promise<WhatsAppCredentials | null> {
  const db = await getDb();
  const [org] = await db
    .select({
      wabaId: organizations.whatsappBusinessAccountId,
      tokenEnc: organizations.whatsappAccessTokenEnc,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (!org?.wabaId) return null;

  if (org.tokenEnc) {
    try {
      return { wabaId: org.wabaId, accessToken: decryptWhatsAppToken(org.tokenEnc) };
    } catch {
      return null; // unusable stored token — nothing safe to do with it
    }
  }

  // Embedded Signup: the office has no token by design and Meta authorised
  // Centro's own System User on its WABA, so the shared token is the correct
  // credential — but it is only ever paired with THIS organization's wabaId,
  // read above. It is never used to reach another tenant's account.
  try {
    const { systemUserToken } = getWhatsAppConfig();
    return systemUserToken ? { wabaId: org.wabaId, accessToken: systemUserToken } : null;
  } catch {
    return null; // WhatsApp not configured at all
  }
}

/**
 * Reads this organization's template statuses from Meta, stores them, and
 * — the first time every managed template is APPROVED — emails the owner.
 *
 * Never throws for an email problem: a failed notification must not turn a
 * successful Meta sync into a failure for the caller.
 */
export async function syncTemplatesAndNotify(organizationId: string): Promise<TemplateSyncResult> {
  const credentials = await resolveCredentials(organizationId);
  if (!credentials) {
    return { synced: 0, allApproved: false, emailSent: false, emailError: null };
  }

  // Deliberately NOT wrapped: a Meta failure here IS a sync failure and the
  // caller should see it.
  const statuses = await fetchTemplateStatuses(credentials.wabaId, credentials.accessToken);

  const db = await getDb();
  let synced = 0;
  let approvedCount = 0;

  for (const definition of MANAGED_TEMPLATES) {
    const remote = statuses.find(
      (candidate) => candidate.name === definition.name && candidate.language === definition.language
    );
    // Meta does not have this template on this WABA. That is a real, distinct
    // state — the office genuinely has nothing to send with — and it used to
    // be a silent `continue`, which left the row absent and the screen saying
    // "טרם הוגשה" (never submitted) whether the template had never been sent
    // for review or had been deleted on Meta's side. Recorded as MISSING so
    // the two are distinguishable.
    if (!remote) {
      const [existingMissing] = await db
        .select({ id: whatsappTemplates.id, status: whatsappTemplates.status })
        .from(whatsappTemplates)
        .where(
          and(
            eq(whatsappTemplates.organizationId, organizationId),
            eq(whatsappTemplates.name, definition.name),
            eq(whatsappTemplates.language, definition.language)
          )
        )
        .limit(1);
      // Only a row that Meta previously knew about becomes MISSING; a local
      // draft that was never submitted stays a local draft.
      if (existingMissing && existingMissing.status !== "LOCAL_DRAFT") {
        await db
          .update(whatsappTemplates)
          .set({ status: "MISSING", lastSyncedAt: new Date(), updatedAt: new Date() })
          .where(eq(whatsappTemplates.id, existingMissing.id));
      }
      continue;
    }

    if (remote.status === "APPROVED") approvedCount += 1;
    synced += 1;

    const values = {
      intent: definition.intent,
      status: remote.status,
      category: remote.category,
      rejectedReason: remote.rejectedReason,
      metaTemplateId: remote.metaTemplateId,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    };

    const [existing] = await db
      .select({ id: whatsappTemplates.id })
      .from(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.organizationId, organizationId),
          eq(whatsappTemplates.name, definition.name),
          eq(whatsappTemplates.language, definition.language)
        )
      )
      .limit(1);

    if (existing) {
      await db.update(whatsappTemplates).set(values).where(eq(whatsappTemplates.id, existing.id));
    } else {
      // On the WABA but never recorded locally — the normal case for an
      // Embedded Signup organization, whose templates nobody submitted
      // through this screen. Adopted rather than ignored.
      await db.insert(whatsappTemplates).values({
        organizationId,
        wabaId: credentials.wabaId,
        name: definition.name,
        language: definition.language,
        bodyText: definition.bodyText,
        variables: ["{{1}}"],
        exampleValues: [],
        ...values,
      });
    }
  }

  const allApproved = approvedCount === MANAGED_TEMPLATES.length;
  if (!allApproved) {
    return { synced, allApproved: false, emailSent: false, emailError: null };
  }

  const { emailSent, emailError } = await notifyTemplatesApproved(organizationId);
  return { synced, allApproved: true, emailSent, emailError };
}

/**
 * Sends the one-time email, safely against concurrency.
 *
 * The claim and the guard are the same statement: NULL → now() only if it
 * is still NULL. Whichever caller's UPDATE commits second matches zero rows
 * and backs off, so a cron pass and a manual refresh running together can
 * never both send. On a send failure the claim is released (back to NULL)
 * so a later attempt can retry — the organization is never left marked as
 * notified when no email actually went out.
 */
export async function notifyTemplatesApproved(
  organizationId: string
): Promise<{ emailSent: boolean; emailError: string | null }> {
  const db = await getDb();

  const [owner] = await db
    .select({ email: users.email, organizationName: organizations.name })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, users.organizationId))
    .where(eq(users.organizationId, organizationId))
    .limit(1);

  if (!owner?.email) {
    return { emailSent: false, emailError: "לארגון אין כתובת מייל רשומה." };
  }

  // Atomic claim.
  const claimed = await db
    .update(organizations)
    .set({ templatesApprovedEmailSentAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(organizations.id, organizationId),
        isNull(organizations.templatesApprovedEmailSentAt)
      )
    )
    .returning({ id: organizations.id });

  if (claimed.length === 0) {
    // Already sent (or claimed by a concurrent caller) — not an error.
    return { emailSent: false, emailError: null };
  }

  const { html, text } = renderTemplatesApprovedEmail();

  try {
    await sendTransactionalEmail({
      to: owner.email,
      subject: TEMPLATES_APPROVED_SUBJECT,
      html,
      text,
    });
  } catch (error) {
    // Release the claim so this can be retried; never leave it marked sent.
    await db
      .update(organizations)
      .set({ templatesApprovedEmailSentAt: null, updatedAt: new Date() })
      .where(eq(organizations.id, organizationId));

    const message = error instanceof Error ? error.message : String(error);
    console.error("[templates-approved-email] send failed; claim released for retry", {
      organizationId,
      error: message,
    });
    return { emailSent: false, emailError: message };
  }

  await recordAuditEvent({
    organizationId,
    eventType: "notification.templates_approved_email_sent",
    description: `נשלח מייל "התבניות אושרו" אל ${owner.email}`,
    actorType: "system",
  });

  return { emailSent: true, emailError: null };
}

/** At most one Meta poll per organization per hour, for this purpose. */
export const TEMPLATE_POLL_THROTTLE = "1 hour";

/**
 * The cron entry point, run once per organization inside the existing
 * per-organization tick loop.
 *
 * Deliberately narrow, so a tick costs at most one Meta call per
 * organization per hour rather than one per tick:
 *   • only organizations genuinely connected to a WABA,
 *   • never one already notified — the whole point of the poll is gone,
 *   • never a suspended one,
 *   • and never one polled inside the throttle window.
 *
 * The eligibility check and the throttle claim are the SAME conditional
 * UPDATE, so two concurrent ticks can never both poll the same
 * organization. Returns false without contacting Meta when not due.
 */
export async function pollTemplateApprovalIfDue(organizationId: string): Promise<boolean> {
  const db = await getDb();

  const claimed = await db
    .update(organizations)
    .set({ templatesLastPolledAt: new Date() })
    .where(
      and(
        eq(organizations.id, organizationId),
        isNotNull(organizations.whatsappBusinessAccountId),
        isNotNull(organizations.whatsappConnectedAt),
        // NOT gated on templatesApprovedEmailSentAt any more. That column
        // exists to send the "your templates are approved" email exactly
        // once, and using it as the poll gate meant status synchronisation
        // stopped permanently the moment that email went out — after which
        // Meta pausing, disabling or deleting a template was invisible to
        // Centro forever. notifyTemplatesApproved keeps its own one-shot
        // claim, so the email still cannot be sent twice.
        isNull(organizations.suspendedAt),
        sql`(${organizations.templatesLastPolledAt} is null
             or ${organizations.templatesLastPolledAt} < now() - interval '${sql.raw(TEMPLATE_POLL_THROTTLE)}')`
      )
    )
    .returning({ id: organizations.id });

  if (claimed.length === 0) return false; // not due, or already notified

  try {
    await syncTemplatesAndNotify(organizationId);
  } catch (error) {
    // A Meta failure must never break the tick for everything else. The
    // throttle stamp stays set, so this retries on the next window rather
    // than hammering a failing endpoint every tick.
    console.error("[templates-approval-poll] Meta sync failed", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}
