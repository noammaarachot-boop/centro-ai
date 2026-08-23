import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  customType,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Raw binary storage — Drizzle has no first-party bytea helper, so this
// is the minimal custom column type needed for documents.pendingFileContent
// below. Only ever holds a document's bytes transiently (between a real
// WhatsApp receipt and an employee's later approve/reject decision);
// never a general-purpose file store.
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// Product Evolution M9 ("Recurring vs. On-Demand"): the onboarding wizard's
// own choice of how the office wants to *start* using Centro. This used to
// be a permanent, organization-wide lock (M1) — it no longer is. Every
// onboarded organization can create both Recurring Collections (Services,
// automatically scheduled) and On-Demand Collections (Templates, sent only
// when an employee decides to) regardless of what they picked here; this
// column only personalizes the wizard's own steps and copy, plus a couple
// of purely cosmetic defaults (which dashboard variant renders by default,
// the AI copilot's one-line self-description). The real, per-item mode gate
// is `services.collectionMode` below — every runtime behavior (learning,
// scheduling, nav) reads that, never this column.
// "one_time" is the pre-M9 value, kept only so existing rows keep meaning
// exactly what they always meant ("started via the on-demand-only wizard
// path") — application code treats it as a synonym for "on_demand" and
// never writes it again. "both" is new: the wizard runs the fuller
// (recurring) setup flow, since post-onboarding on-demand needs no extra
// steps of its own (see src/app/onboarding/page.tsx).
export const workflowTypeEnum = pgEnum("workflow_type", [
  "recurring",
  "one_time",
  "on_demand",
  "both",
]);

// Owns all configuration, users and (starting M3) clients/services/collection
// data. EPS Ch.2 PR-005 / Ch.8: every other table is scoped to one of these.
//
// The three *ConnectedAt / *ActivatedAt columns track the Ch.3 onboarding
// gate (BR-001: "Automation cannot be activated until all mandatory
// integrations are connected"). Google Drive is real: googleConnectedAt is
// set by the actual OAuth callback (src/app/api/auth/google/callback/route.ts)
// once tokens are obtained, and automation additionally requires
// googleDriveFolderId to be set (see tryActivateAutomation in
// onboarding/actions.ts) — Centro must have both a connected account and a
// selected folder before it can do anything with Drive. WhatsApp is real
// too (src/lib/whatsapp/, src/app/api/auth/whatsapp/callback/route.ts) —
// unlike Google, no per-org access/refresh token is stored: Centro is a
// Meta Tech Provider and sends/receives for every connected organization
// through one shared System User token (WHATSAPP_SYSTEM_USER_TOKEN),
// scoped per-call by whatsappPhoneNumberId. These columns only identify
// which WhatsApp Business Account/number this organization owns.
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  googleConnectedAt: timestamp("google_connected_at", { withTimezone: true }),
  // Encrypted at rest (AES-256-GCM, src/lib/googleAuth/tokenCipher.ts) —
  // these grant real access to a real Google Drive folder, never stored or
  // logged in plaintext. refreshToken is nullable because Google only
  // issues one on the very first consent (with prompt=consent); a later
  // token refresh response never repeats it, so an existing refresh token
  // must never be overwritten with null.
  googleAccessTokenEnc: text("google_access_token_enc"),
  googleRefreshTokenEnc: text("google_refresh_token_enc"),
  googleTokenExpiresAt: timestamp("google_token_expires_at", { withTimezone: true }),
  // The single folder Centro is scoped to for this organization — chosen
  // by the user (existing folder via Google Picker, or a newly created
  // one) right after OAuth, under the minimal drive.file scope (see
  // src/lib/googleAuth/config.ts). Centro never has access to anything
  // outside this folder.
  googleDriveFolderId: text("google_drive_folder_id"),
  googleDriveFolderName: text("google_drive_folder_name"),
  whatsappConnectedAt: timestamp("whatsapp_connected_at", {
    withTimezone: true,
  }),
  // WABA id from Embedded Signup — the whole business account, which may
  // in principle own more than one phone number (Centro only ever uses
  // the one number resolved at connect time, referenced below).
  whatsappBusinessAccountId: text("whatsapp_business_account_id"),
  // Required on every Cloud API send/receive call — this, not the WABA id,
  // is what the webhook payload's metadata.phone_number_id is matched
  // against to resolve which organization an inbound message belongs to.
  whatsappPhoneNumberId: text("whatsapp_phone_number_id"),
  // Display-only — shown in Settings/Step3Connect so the accountant can
  // confirm which number is connected.
  whatsappDisplayPhoneNumber: text("whatsapp_display_phone_number"),
  whatsappVerifiedName: text("whatsapp_verified_name"),
  // Manual per-organization WhatsApp connection (owner-only, /owner/organizations/[id])
  // — an office that set up its own Cloud API access outside Embedded
  // Signup and gave Centro's owner its own Access Token, rather than
  // relying on the shared WHATSAPP_SYSTEM_USER_TOKEN. Encrypted at rest
  // (AES-256-GCM, src/lib/whatsapp/tokenCipher.ts — same scheme as
  // googleAccessTokenEnc, but its own dedicated key,
  // WHATSAPP_TOKEN_ENCRYPTION_KEY, so the two integrations' key material
  // never overlaps). Null for every organization connected the existing
  // way (Embedded Signup) — sendViaWhatsApp (conversationOrchestration.ts)
  // and downloadMedia callers (the webhook route) use this when present
  // and fall back to WHATSAPP_SYSTEM_USER_TOKEN when it's null, so an
  // Embedded-Signup-connected organization's behavior is completely
  // unchanged.
  whatsappAccessTokenEnc: text("whatsapp_access_token_enc"),
  // Per-phone-number webhook override (Meta "Webhook overrides":
  // POST /<PHONE_NUMBER_ID> with webhook_configuration). Meta resolves an
  // inbound event's destination phone-number override first, then the
  // WABA's, then the app's default callback URL — so when this is set,
  // this organization's messages arrive at
  // /api/webhooks/whatsapp/<phoneNumberId> instead of the shared
  // /api/webhooks/whatsapp. Null means no override is active and the
  // shared app-level URL handles it, exactly as before (every Embedded
  // Signup organization). Stored in plaintext, unlike
  // whatsappAccessTokenEnc: this value only ever proves the one-time
  // hub.challenge handshake (it grants no API access at all), the owner is
  // shown it deliberately so a connection can be verified/re-entered in
  // Meta by hand, and message authenticity is enforced separately by the
  // X-Hub-Signature-256 HMAC against WHATSAPP_APP_SECRET — which the
  // override does not change, since events still come from the same App.
  whatsappWebhookVerifyToken: text("whatsapp_webhook_verify_token"),
  // When Meta actually accepted the override registration
  // (setPhoneNumberWebhookOverride). Null means Centro generated the URL
  // and token — and the dynamic route will honour them — but Meta has not
  // been told to use them, so events still arrive on the shared app-level
  // endpoint until someone registers the override (automatically on a
  // retry, or by hand in the Meta dashboard using the exact URL/token the
  // owner screen shows). Deliberately separate from the token itself: the
  // token stays put either way, so the owner can always SEE and copy the
  // pair, and this column is the honest answer to "is Meta actually
  // routing here yet".
  whatsappWebhookOverrideAt: timestamp("whatsapp_webhook_override_at", { withTimezone: true }),
  // Result of the last EXPLICIT connection check the owner ran ("בדוק
  // וחבר" / "בדוק חיבור"), per integration. These exist so the owner
  // screens can show a truthful "דורש טיפול" without making a live Meta /
  // Google API call for every organization on every list render.
  //
  // Deliberately a point-in-time result, not a sticky flag: a failing
  // check is only treated as a current problem while it is still the most
  // recent evidence. A later successful check overwrites it, and for
  // WhatsApp a successful send after checkedAt also clears it — see
  // resolveConnectionHealth (src/lib/owner/connectionHealth.ts). That is
  // what stops a resolved historical failure from pinning an organization
  // red forever.
  whatsappHealthOk: boolean("whatsapp_health_ok"),
  whatsappHealthReason: text("whatsapp_health_reason"),
  whatsappHealthCheckedAt: timestamp("whatsapp_health_checked_at", { withTimezone: true }),
  googleHealthOk: boolean("google_health_ok"),
  googleHealthReason: text("google_health_reason"),
  googleHealthCheckedAt: timestamp("google_health_checked_at", { withTimezone: true }),
  // One-time "your templates are approved" email to the office owner.
  //
  // Doubles as the concurrency claim: the sender flips NULL → now() in a
  // single conditional UPDATE and only proceeds if that update matched a
  // row, so a cron pass and a manual refresh running at the same moment
  // can never both send. Reset back to NULL if the send itself then fails,
  // which is what makes a retry safe rather than permanently suppressed —
  // see notifyIfTemplatesApproved (lib/whatsapp/templateApprovalNotice.ts).
  //
  // Also the signal that stops the cron re-checking this organization's
  // templates: once set, there is nothing left for that pass to do.
  templatesApprovedEmailSentAt: timestamp("templates_approved_email_sent_at", {
    withTimezone: true,
  }),
  // Throttle for the background template-approval poll. The cron pass only
  // considers organizations not polled within the last hour, so a tick
  // costs at most one Meta call per organization per hour rather than one
  // per tick — and organizations already notified drop out entirely (see
  // listOrganizationsAwaitingTemplateApproval).
  templatesLastPolledAt: timestamp("templates_last_polled_at", { withTimezone: true }),
  // Per-organization Meta template-approval tracking (Phase 2.1 remediation).
  // Message-template review/approval happens per-WABA on Meta's side, not
  // globally — a template approved on one office's WhatsApp Business
  // Account tells you nothing about whether it's approved on a DIFFERENT
  // office's WABA. These replace what used to be a single hardcoded
  // boolean (INITIAL_REQUEST_V2_ENABLED / REMINDER_V2_ENABLED in
  // src/lib/whatsapp/templates.ts) applied to every organization — which
  // meant the very first automated message to the SECOND office to ever
  // connect would silently fail (Meta rejects a template send on a WABA
  // where it isn't approved yet). Default false: every newly-connected
  // organization starts on the always-approved static v1 templates,
  // never guessing that Meta has approved anything.
  //
  // Never set automatically — Meta does not expose a webhook/callback this
  // codebase consumes for template approval events, so a human (the
  // platform owner, via /owner) must confirm in Meta Business Manager that
  // the specific WABA's copy of the template is actually APPROVED before
  // flipping this to true. Flipping it early would repeat exactly the bug
  // this column exists to fix, just scoped to one org instead of all of
  // them.
  initialRequestV2Approved: boolean("initial_request_v2_approved").notNull().default(false),
  reminderV2Approved: boolean("reminder_v2_approved").notNull().default(false),
  // Explicit, dedicated gate for the automated document-collection
  // pipeline — the long-term source of truth that supersedes
  // automationActivatedAt for this purpose (which is kept only for
  // backward compatibility during the transition). Governs ONLY autonomous
  // ("automated"-trigger) sends: the initial document request when it's
  // fired by a scheduler/cron, follow-up prompts, reminders, and
  // auto-confirmations. A human-initiated ("manual"-trigger) send is never
  // gated by this. Default false; set true automatically the moment
  // WhatsApp finishes connecting (storeWabaConnection), and toggleable from
  // Settings. An org with no connected WhatsApp stays false.
  documentCollectionEnabled: boolean("document_collection_enabled")
    .notNull()
    .default(false),
  // Product Evolution M9 ("Disable automation must really disable
  // automation") — this column already behaved as a live on/off toggle
  // (activateAutomation/deactivateAutomation in onboarding/actions.ts set
  // and clear it, not only once at onboarding), it just wasn't actually
  // *consulted* by the send/scheduling pipeline before now. Null halts
  // every automatic action org-wide: no new recurring cycle is created
  // (see services.collectionMode's scheduler consumer) and no automated
  // WhatsApp send goes out (conversationOrchestration.ts's
  // sendOutboundMessage checks this before ever calling the transport).
  // Never touches historical data — purely a forward-looking gate on the
  // write/send paths. A per-Service pause (services.automationPausedAt) is
  // the narrower sibling of this — this one wins over everything when
  // null, regardless of any individual Service's own state.
  automationActivatedAt: timestamp("automation_activated_at", {
    withTimezone: true,
  }),
  // Ch.18 configuration. businessDays is stored as comma-separated weekday
  // numbers (0=Sunday..6=Saturday) rather than a Postgres array type —
  // simpler to read/write from plain form inputs, and there's no query
  // that needs to filter by individual day. Defaults match a Sun-Thu week
  // and the Ch.16 FR-16.4 "10-15 minutes" example.
  businessHoursStart: text("business_hours_start").notNull().default("09:00"),
  businessHoursEnd: text("business_hours_end").notNull().default("18:00"),
  businessDays: text("business_days").notNull().default("0,1,2,3,4"),
  // IANA zone name — business-hours/reminder scheduling (src/lib/businessHours.ts)
  // evaluates businessHoursStart/End against wall-clock time in THIS zone,
  // never the server process's own local time (Vercel serverless functions
  // run in UTC; without this, "09:00-18:00" silently meant 09:00-18:00 UTC,
  // not Israel local time, for every organization). Defaults to Israel
  // since every organization on this platform is an Israeli firm today.
  timezone: text("timezone").notNull().default("Asia/Jerusalem"),
  reminderIntervalDays: integer("reminder_interval_days").notNull().default(2),
  // Hour-granularity reminder cadence (1-24h), replacing reminderIntervalDays
  // above as the field the scheduler actually reads — reminderIntervalDays
  // stays in the schema (not dropped) but is no longer consulted anywhere.
  // Default 5h per product decision; UI/server actions clamp any value a
  // user sets to 1..24 (never trust the client — see clampCollectionDay's
  // own doc comment for the same discipline applied to another field).
  reminderIntervalHours: integer("reminder_interval_hours").notNull().default(5),
  inactivityTimeoutMinutes: integer("inactivity_timeout_minutes")
    .notNull()
    .default(15),
  // How many reminder nudges an unanswered document-intake confirmation
  // (unsolicited_document / document_clarification — see
  // src/lib/documentIntakeReview.ts) gets, spaced reminderIntervalDays
  // apart (reusing the interval above rather than adding a second one),
  // before escalating to needs_review. needs_review is the *last* resort
  // per product requirement — never the first response to an unmatched
  // document.
  confirmationMaxReminders: integer("confirmation_max_reminders")
    .notNull()
    .default(2),
  // Smart notification grouping window (pendingConfirmations.ts's
  // flushDueIntakeNotifications) — how long to hold an unsolicited_document/
  // identity_anomaly question after the first one on a request, so several
  // documents/anomalies arriving in a short burst reach the client as one
  // combined WhatsApp message instead of one per file. Configurable per
  // organization, never hard-coded.
  documentGroupingWindowSeconds: integer("document_grouping_window_seconds")
    .notNull()
    .default(15),
  // Office policy (Architecture Ch.8: Centro learns which documents to
  // collect, never when — this is configured once by the accountant and
  // never touched automatically). The day of the month collection begins
  // for this organization by default; a Business Type (Service) may
  // override it, same pattern as the five fields above. 1-31; stored as a
  // plain integer since there's no calendar-aware "day 31 in February"
  // logic anywhere yet — no scheduler currently auto-creates Collection
  // Requests (they're opened manually), so this is a stored, editable
  // policy value with no automated consumer yet, not a live cron trigger.
  collectionDayOfMonth: integer("collection_day_of_month").notNull().default(1),
  // Product Evolution M1: what kind of business this office itself is —
  // distinct from `business_types` below, which classifies this office's
  // *clients* and is Workflow A (recurring) only. Used for onboarding
  // personalization, analytics, and AI-driven starter document suggestions
  // for business types Centro has no built-in defaults for (see
  // src/lib/ai/businessCategorySuggestions.ts, M2). One of a fixed preset
  // list, or "other" with the free-text label below. Defaults to
  // "accountant" so every pre-existing organization is classified as
  // exactly what it already is.
  businessCategory: text("business_category").notNull().default("accountant"),
  // Free text, only meaningful when businessCategory = "other".
  businessCategoryCustomLabel: text("business_category_custom_label"),
  // See the workflowTypeEnum comment above this table.
  workflowType: workflowTypeEnum("workflow_type").notNull().default("recurring"),
  // Epic 2: set once the org has been through (today: the relocated
  // "Office Setup" flow at /onboarding; later: the real onboarding wizard).
  // Gates whether a login/registration lands on /onboarding or /dashboard —
  // see src/lib/onboarding.ts. Nullable/unset means "not yet onboarded".
  onboardingCompletedAt: timestamp("onboarding_completed_at", {
    withTimezone: true,
  }),
  // Epic 3: which wizard step (0-indexed) a first-time user last completed,
  // so closing the tab mid-wizard resumes there instead of restarting.
  onboardingStep: integer("onboarding_step").notNull().default(0),
  // Small logo image, stored directly as a data: URL (no blob storage
  // exists in this project; a data URL is a real, working solution at this
  // size, not a mock). Set in the onboarding wizard's Office Information
  // step, editable later from Settings.
  logoUrl: text("logo_url"),
  // UX Polish M4 — set the first time a one-time-workflow organization's
  // dashboard renders the "Sample Template" promo card, so it shows exactly
  // once. Null forever for a recurring-workflow organization, which never
  // renders that card.
  sampleTemplateCardShownAt: timestamp("sample_template_card_shown_at", {
    withTimezone: true,
  }),
  // Owner Dashboard Phase 5 — platform-owner-only account lifecycle
  // action (src/app/owner/(dashboard)/organizations/[id]/actions.ts).
  // Null = active. Enforced in src/lib/auth/session.ts's requireSession()
  // (not getSession() itself, whose null/non-null contract many other
  // callers — the login page, redirectAfterAuth — depend on unchanged);
  // read as part of getSession()'s existing organizations join, so
  // checking it costs zero extra queries on the app's hottest read path.
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  // Internal QA Mode — platform-owner-only, toggled from the same
  // organizations list as suspend/reactivate
  // (src/app/owner/(dashboard)/organizations/[id]/actions.ts). Lets one
  // marked organization finish onboarding without a real WhatsApp
  // connection, for manual testing while Meta's WhatsApp approval is
  // pending. Google Drive is never bypassed. Read as part of
  // getSession()'s existing organizations join (src/lib/auth/session.ts),
  // same zero-extra-query pattern as suspendedAt — every real enforcement
  // point (finishOnboarding, tryActivateAutomation) re-reads this from the
  // authenticated session/DB itself, never trusts a client-supplied value.
  qaModeEnabledAt: timestamp("qa_mode_enabled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  // Multi-tenant safety backstop (Phase 1.6 remediation) — findOrganizationByPhoneNumberId
  // (src/app/api/webhooks/whatsapp/route.ts) routes every inbound WhatsApp
  // message/document by this value alone with a bare .limit(1); without a
  // DB-level constraint, a future storeWabaConnection bug (or a stale row
  // from a disconnected org never cleared) could silently make two
  // organizations share the same value, misrouting one tenant's real
  // WhatsApp traffic to another. Partial (WHERE ... IS NOT NULL) so any
  // number of disconnected organizations can all sit at null.
  uniqueIndex("organizations_whatsapp_phone_number_id_idx")
    .on(table.whatsappPhoneNumberId)
    .where(sql`${table.whatsappPhoneNumberId} is not null`),
  uniqueIndex("organizations_whatsapp_business_account_id_idx")
    .on(table.whatsappBusinessAccountId)
    .where(sql`${table.whatsappBusinessAccountId} is not null`),
]);

// The Pilot MVP uses a single shared employee account per firm (EPS Ch.13
// BR-13.1) rather than individual employee identities — one row per
// Organization, created alongside it (see scripts/create-organization.ts,
// or self-service via the Epic 2 registration flow in src/app/login/actions.ts).
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  // Nullable: accounts provisioned via scripts/create-organization.ts don't
  // collect one. Self-service registration always sets it.
  fullName: text("full_name"),
  // Product Evolution M1: the office's own contact number, collected at
  // registration. Nullable for the same reason fullName is — the
  // script-based provisioning path doesn't collect it; self-service
  // registration always sets it.
  phone: text("phone"),
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
  privacyAcceptedAt: timestamp("privacy_accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// UX Polish M7 — the forgot-password flow. `token` stores the literal
// random lookup value directly (matching sessions.id's existing precedent
// of storing the secret itself, not a hash — this codebase has no
// hashed-token pattern to deviate toward). `usedAt` null = unused; single-
// use is enforced by setting it the moment a reset succeeds, never by
// deleting the row (kept for audit/debugging, same spirit as auditLogs
// being insert-only).
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// AI events use "ai", client-initiated events (e.g. WhatsApp messages) use
// "client", unattended scheduled behavior uses "system" — matches the actor
// vocabulary in FR-17.2 ("AI, employee, or client").
export const auditActorType = pgEnum("audit_actor_type", [
  "employee",
  "ai",
  "client",
  "system",
]);

// One immutable row per significant event (EPS Ch.17). Only inserts are
// ever performed against this table — FR-17.4 requires audit records to be
// uneditable/undeletable through the application. `metadata` holds
// event-specific detail (e.g. previous/new status) alongside the always
// -present, queryable core columns; it is a supplement to those columns,
// not a substitute for them (Ch.8 explicitly puts generic JSON event
// storage out of scope).
export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  occurredAt: timestamp("occurred_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  eventType: text("event_type").notNull(),
  actorType: auditActorType("actor_type").notNull(),
  // set null (not restrict) on delete: audit_logs is an observability trail,
  // not business data, so a deleted User/Client must never block itself
  // from ever being deletable just because it was once mentioned in a log
  // entry — the record survives with the reference cleared instead.
  actorUserId: uuid("actor_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  // "related client" per FR-17.2; null for org-level events (login, config,
  // organization creation) that aren't about one specific client.
  clientId: uuid("client_id").references(() => clients.id, {
    onDelete: "set null",
  }),
  // FR-17.3: "employees shall be able to view the chronological history of
  // a Collection Request" — a client can have many Collection Requests
  // over time, so clientId alone isn't precise enough for that view.
  collectionRequestId: uuid("collection_request_id").references(
    () => collectionRequests.id,
    { onDelete: "set null" }
  ),
  description: text("description").notNull(),
  metadata: jsonb("metadata"),
});

// Business record only — a Client never authenticates into Centro (EPS
// Ch.2, Ch.4 BR-002). `phone` is the WhatsApp address used from M6 onward,
// so it must be unique per organization — one client per WhatsApp number.
export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    email: text("email"),
    notes: text("notes"),
    // BR-3.003: store the Drive folder ID, not its name. Created lazily
    // (see src/lib/storage/driveAdapter.ts) the first time a document for
    // this client is approved, rather than during client creation.
    driveFolderId: text("drive_folder_id"),
    // Epic 3: the onboarding wizard's AI-assisted classification (mocked —
    // see src/lib/ai/businessTypeClassifier.ts). Null = "Unclassified".
    // Business Type is a product concept only — see business_types below.
    businessTypeId: uuid("business_type_id").references(() => businessTypes.id, {
      onDelete: "set null",
    }),
    // Epic 4: confidence (0-100) of the classification above, whichever
    // layer produced it — null when never classified (Unclassified) or
    // when set by a human directly (a manual assignment is definitionally
    // 100% confident, not a guess). Lets Step 5 distinguish "auto-classified
    // with certainty" (>=95) from "suggested, worth a glance" (70-94) rather
    // than treating every classified client identically.
    businessTypeConfidence: integer("business_type_confidence"),
    // Product Evolution M9 ("AI Suggests, User Approves") — null means this
    // client's businessTypeId (if any) is still only a suggestion: it has
    // NOT yet been confirmed by a human, and per assignClientsToBusinessType
    // (src/lib/businessTypes.ts) it does not yet carry a clientServices
    // assignment either — so it cannot yet affect what's requested from
    // this client. Set the moment a human confirms the classification
    // (Step 5's "Confirm" action, whether that's a bulk approval of an
    // already-suggested group or a manual assignment/correction — both go
    // through the same confirmation step now). A manual assignment is
    // confirmed by construction the instant it's made.
    classificationConfirmedAt: timestamp("classification_confirmed_at", {
      withTimezone: true,
    }),
    // Epic 4: the raw business-type-column (or row-context) text an import
    // produced for this client, kept even when classification failed or
    // was only a low-confidence guess. src/lib/businessTypes.ts's learning
    // mechanism reads this back when a human later manually assigns a
    // Business Type, so it can remember "this exact text means this type"
    // for this organization's future imports — never touched afterward.
    importedBusinessTypeText: text("imported_business_type_text"),
    // Onboarding UX refinement: set only on clients inserted by the
    // wizard's own Import Excel/CSV step (src/app/onboarding/actions.ts's
    // importParsedRows). The one thing "Replace Excel file" is allowed to
    // delete — never a pre-existing or manually-added client — so this
    // flag is what makes that distinction possible. Meaningless (and
    // never consulted) once onboarding is complete.
    importedDuringOnboarding: boolean("imported_during_onboarding")
      .notNull()
      .default(false),
    // Milestone 2 (Architecture Ch.1/Ch.2): every client starts in Learning
    // Mode. The only thing this flag gates is Milestone 6's "document
    // appears to no longer be needed" detection — a client with zero
    // completed cycles has no pattern to compare against yet, so that
    // check must never fire for them. Flipped once, the first time this
    // client's first Collection Request reaches `completed`
    // (collectionRequestStateMachine.ts), and never touched again.
    learningMode: boolean("learning_mode").notNull().default(true),
    firstCycleCompletedAt: timestamp("first_cycle_completed_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("clients_organization_id_phone_idx").on(
      table.organizationId,
      table.phone
    ),
  ]
);

// Product Evolution M9: whether one specific Service/Template is a
// Recurring Collection (Centro automatically opens its next cycle on a
// schedule) or an On-Demand Collection (an employee decides when to send
// it; never auto-repeats). This — not organizations.workflowType — is the
// real, per-item gate every runtime behavior checks: the learning engine
// (src/lib/clientDocumentProfile.ts, src/lib/documentLearning.ts), the
// automatic cycle-creation scheduler (src/lib/recurringScheduler.ts), and
// nothing else — Templates/Services pages are simply always both visible
// post-onboarding now, no gate needed there at all.
export const serviceCollectionModeEnum = pgEnum("service_collection_mode", [
  "recurring",
  "on_demand",
]);

// Defines recurring document requirements (EPS Ch.4 BR-001: "Services
// define requirements; clients do not"). Scheduling config (frequency,
// business hours) is added when the collection engine is built — it has
// no meaning until something actually consumes it.
export const services = pgTable("services", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  // Product Evolution M9. Defaults to "on_demand" at the column level —
  // every pre-M9 row is backfilled explicitly by migration 0028 (Recurring
  // if it backs a business_types row, On-Demand otherwise), so the default
  // only ever applies to a genuinely new row going forward.
  collectionMode: serviceCollectionModeEnum("collection_mode")
    .notNull()
    .default("on_demand"),
  // "Every X months" — 1=monthly, 2=every two months, 3=quarterly,
  // 6=every six months, 12=annually, or any other positive integer for a
  // custom cadence. One field covers every named option and "custom" at
  // once, deliberately — a separate unit/enum was considered and rejected
  // as unnecessary complexity for what is always, in the end, a count of
  // months. Null = collectionMode is "on_demand" (frequency is meaningless
  // for it), or a "recurring" Service whose schedule hasn't been
  // configured yet. See src/lib/recurringScheduler.ts for the engine that
  // actually consumes this.
  collectionFrequencyIntervalMonths: integer(
    "collection_frequency_interval_months"
  ),
  // Product Evolution M9 — the narrower, per-template sibling of
  // organizations.automationPausedAt: pausing one Recurring Collection
  // (e.g. one Business Type) never affects any other Service's automatic
  // cycles or messages. Meaningless for an On-Demand Service (nothing
  // automatic ever runs for one), but not enforced NOT NULL-false-only at
  // the schema level since it costs nothing to allow and simplifies the
  // scheduler's WHERE clause (checked unconditionally, matches nothing for
  // an on_demand row either way).
  automationPausedAt: timestamp("automation_paused_at", { withTimezone: true }),
  // Epic 3: per-business-type reminder/business-hours overrides, set from
  // the onboarding wizard's Reminder Rules step (or later from this
  // service's own page). Null = "use the organization's default" — see
  // resolveScheduleConfig() in src/lib/businessHours.ts, the single place
  // that resolves these against organizations' equivalent columns. Every
  // service created before Epic 3 has all five null, so scheduler.ts and
  // conversationOrchestration.ts behave exactly as before for it.
  reminderIntervalDaysOverride: integer("reminder_interval_days_override"),
  // Hour-granularity override (1-24h), replacing reminderIntervalDaysOverride
  // above as the field resolveScheduleConfig actually reads. Null = "use the
  // organization's own reminderIntervalHours default", same convention as
  // every other override on this table.
  reminderIntervalHoursOverride: integer("reminder_interval_hours_override"),
  inactivityTimeoutMinutesOverride: integer(
    "inactivity_timeout_minutes_override"
  ),
  businessHoursStartOverride: text("business_hours_start_override"),
  businessHoursEndOverride: text("business_hours_end_override"),
  businessDaysOverride: text("business_days_override"),
  // Same override pattern, for organizations.collectionDayOfMonth — null =
  // "use the organization's default".
  collectionDayOfMonthOverride: integer("collection_day_of_month_override"),
  // UX Polish M4 — true only for the starter templates seedExampleTemplates
  // auto-creates for a one-time-workflow organization's first /templates
  // visit. A user explicitly adding a library entry (createTemplateFromLibrary)
  // or duplicating a template never sets this — "sample" means system-seeded,
  // not merely library-sourced. Always false for the recurring workflow.
  isSampleTemplate: boolean("is_sample_template").notNull().default(false),
  // "Mark, never delete" convention, same as approvedPolicies.isActive/
  // retiredAt above — a template is a reusable definition, while every
  // collectionRequests row it ever produced is its own independent
  // historical instance (BR-002: requirements are snapshotted, never
  // live-referenced). Deleting a template must never break, hide, or
  // orphan a single historical request, so the row is retired in place
  // rather than actually removed: listTemplatesWithActiveCounts excludes
  // it from the gallery and sendTemplateRequest refuses to start a new
  // request from it, but every existing collectionRequests.serviceId FK
  // (and every live join to this row's own name/description) keeps
  // resolving exactly as before, forever. Null = active/available.
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// The template of documents a Service always requires (e.g. "Bank
// Statement"). Collection Requests copy these into their own requirement
// rows at creation time (see collectionRequestRequirements) rather than
// referencing them live, per BR-002: "Historical Collection Requests
// always use a snapshot of the Service configuration."
export const serviceDocumentRequirements = pgTable(
  "service_document_requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    // Product Evolution M5: user-controlled document ordering for
    // Templates. Null for every requirement created before this milestone
    // (and for the recurring workflow generally, which never sets it) —
    // listServiceRequirements orders by position first, falling back to
    // createdAt, and Postgres sorts NULLs last on ascending order by
    // default, so an all-null service's requirements keep exactly their
    // original creation-time order with no special-case code needed.
    position: integer("position"),
    // Semantic requirement engine (src/lib/ai/requirementSemantics.ts) — the
    // office user's free text (`name`) is the source of truth; this is the
    // structured interpretation of it (RequirementSemanticSpec), parsed once
    // at save time via AI, never guessed silently below a confidence floor
    // (see requirementSemantics.ts's own doc comment for the office-user
    // clarification flow). Null for a requirement created before this
    // feature, or if parsing genuinely failed — src/lib/documentQuantity.ts's
    // computeRequirementSatisfaction falls back to today's exact
    // one-document/distinct-label behavior when this is null.
    semanticSpec: jsonb("semantic_spec"),
    // Mirrors collectionRequestRequirements.requiredCount — kept here too
    // (not only derivable from semanticSpec) so a requirement's own count is
    // never lost if the spec fails to parse; default 1 preserves today's
    // exactly-one-document behavior.
    requiredCount: integer("required_count").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  }
);

// Epic 3 — the onboarding wizard's "Business Type" is a product/UI concept
// only; under the hood each row here is backed by exactly one auto-managed
// Service (serviceId) of the same name, reusing the entire existing
// Service -> serviceDocumentRequirements -> Collection Request engine
// untouched. Org-scoped (not a shared global catalog) so each firm can
// freely rename/add/remove its own types. isCustom distinguishes the five
// wizard-seeded starter types from ones an office added itself, for
// display purposes only — both behave identically.
export const businessTypes = pgTable("business_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  // Display label, Hebrew, fully user-editable — never matched against
  // directly by the classifier (see canonicalKey below). This is what
  // broke across the English->Hebrew rename two epics ago: matching logic
  // depended on this exact string. It never will again.
  name: text("name").notNull(),
  // Epic 4: a stable, renaming-proof identity for the five standard
  // starter types (STARTER_BUSINESS_TYPES in src/lib/businessTypes.ts) —
  // 'limited_company' | 'authorized_dealer' | 'exempt_dealer' | 'nonprofit'
  // | 'payroll_only'. Null for org-created custom types, which have no
  // global canonical concept and are matched by name like before. The
  // classifier (src/lib/ai/businessTypeClassifier.ts) matches synonyms to
  // a canonical key, then looks up the org's row by that key — renaming a
  // type's display label can never again break classification.
  canonicalKey: text("canonical_key"),
  serviceId: uuid("service_id")
    .notNull()
    .references(() => services.id, { onDelete: "cascade" }),
  isCustom: boolean("is_custom").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Epic 4 STEP 7 ("Learn From Corrections") — when a human manually assigns
// a Business Type to a client whose import row had raw, unrecognized text
// (clients.importedBusinessTypeText), that text is remembered here as a
// synonym scoped to this one organization. Future imports for the same
// org check this table first (src/lib/businessTypes.ts's
// getLearnedSynonyms), so the same office's own shorthand is recognized
// immediately next time — no global retraining, no effect on any other
// organization.
export const businessTypeLearnedSynonyms = pgTable(
  "business_type_learned_synonyms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessTypeId: uuid("business_type_id")
      .notNull()
      .references(() => businessTypes.id, { onDelete: "cascade" }),
    // Normalized (trimmed/lowercased) source text, e.g. "מורשה".
    sourceText: text("source_text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("business_type_learned_synonyms_org_text_idx").on(
      table.organizationId,
      table.sourceText
    ),
  ]
);

// Milestone 3 ("Document Classification Learning") — Ch.6 Decision
// Hierarchy's Learned Knowledge layer, generalized from business-type
// synonyms (Epic 4) to document classification. Recorded every time an
// employee manually assigns an unmatched document to a requirement
// (src/app/(app)/collections/actions.ts's assignDocumentRequirement) —
// one row per correction, not deduplicated, since filenames vary too much
// month to month for exact-text matching the way a business-type synonym
// can be. Matching is by token-overlap similarity against a client's own
// history (src/lib/ai/documentClassifier.ts), scoped to exactly this
// client — never shared across clients or organizations.
export const documentLearnedPatterns = pgTable("document_learned_patterns", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  // The stable, cross-cycle identity of the requirement — the *template*
  // row (serviceDocumentRequirements.id), not the frozen per-cycle
  // snapshot (collectionRequestRequirements.id, a fresh row every cycle) —
  // so a pattern learned this cycle is still recognizable next cycle.
  sourceRequirementId: uuid("source_requirement_id")
    .notNull()
    .references(() => serviceDocumentRequirements.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// A Client may have multiple Services and a Service may be assigned to
// multiple Clients (Ch.4 FR-001/FR-002) — many-to-many join.
export const clientServices = pgTable(
  "client_services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Product Evolution M9 — lives on this join row, not on `services`,
    // because different clients can be assigned to the same Recurring
    // Service at different times and each needs its own independent "next
    // cycle due" clock. Null whenever the Service isn't (yet) a configured
    // Recurring Collection. Set the moment a client is assigned to a
    // Recurring Service with a frequency already configured, and advanced
    // by +collectionFrequencyIntervalMonths each time the scheduler
    // (src/lib/recurringScheduler.ts) successfully opens a new cycle for
    // this exact pairing — recomputed from "now" (not the original anchor)
    // whenever the Service's frequency/anchor day changes, so a
    // mid-stream schedule edit takes effect immediately rather than
    // silently drifting.
    nextCollectionRunAt: timestamp("next_collection_run_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("client_services_client_id_service_id_idx").on(
      table.clientId,
      table.serviceId
    ),
  ]
);

// EPS Ch.6: Draft → Active → Waiting for Client → Processing → Completed /
// Escalated / Cancelled.
export const collectionRequestStatus = pgEnum("collection_request_status", [
  "draft",
  "active",
  "waiting_for_client",
  "processing",
  "completed",
  "escalated",
  "cancelled",
]);

// One document collection cycle for one Client and period (EPS Ch.4/Ch.8).
export const collectionRequests = pgTable("collection_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  serviceId: uuid("service_id")
    .notNull()
    .references(() => services.id),
  status: collectionRequestStatus("status").notNull().default("draft"),
  periodLabel: text("period_label").notNull(),
  // Product Evolution M7 — Workflow B's "Send Request: Now or Schedule."
  // Null for every recurring-workflow request (createCollectionRequest
  // never sets it) and for a one-time request already sent. A non-null
  // value on a still-`draft` request means "not yet delivered, due at
  // this time" — src/lib/scheduledSend.ts's attemptScheduledDelivery is
  // the only place that ever clears it (by successfully sending), and
  // src/lib/scheduler.ts's cron tick is what retries it if the first
  // attempt landed outside business hours.
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // Google Drive monthly folder structure — <org root>/<Hebrew month
  // year>/<client>/<documents>. Resolved once (see ensureDrivePath /
  // ensureCollectionRequestDriveFolder in src/lib/storage/driveAdapter.ts)
  // from this request's own createdAt, and cached here so every document
  // this request ever receives — the first and the fifteenth, minutes or
  // days apart — uploads into the exact same Drive folder without a fresh
  // search. Scoped per request (not per client) because the desired
  // structure buckets a client's documents by the month their collection
  // cycle started, matching a recurring bookkeeping/accounting workflow
  // where each month's documents are reviewed as their own batch.
  driveClientFolderId: text("drive_client_folder_id"),
  // Post-completion extension flow (src/lib/requestExtension.ts) — true only
  // while a client who confirmed "yes, save the extra documents" after this
  // request already completed is actively adding more. While true, a
  // document arriving no longer auto-completes/closes the request the
  // instant it happens to satisfy every requirement (processInboundAttachment's
  // immediate-completion check) — the client may still have more to add and
  // hasn't said so yet. Cleared back to false the moment the request
  // actually re-completes (an explicit "finished" signal, or the
  // extension-finished-check confirmation), by attemptFinishCollectionRequest.
  extensionActive: boolean("extension_active").notNull().default(false),
  // Human-review escalation policy — the request has a standing 3-day
  // window to complete (from entering waiting_for_client, or reset to the
  // resolved date + 3 days each time a client-requested deferral is
  // granted). Null while not on this clock at all (draft/completed/
  // cancelled/escalated). scheduler.ts's escalation pass transitions the
  // request to "escalated" (the pre-existing, previously-unused status —
  // see collectionRequestStateMachine.ts) the moment this is reached
  // without completion, via the same atomic-claim discipline as every
  // other scheduler pass.
  reviewDeadlineAt: timestamp("review_deadline_at", { withTimezone: true }),
  // How many deferral requests (dated or vague, any wording) this request
  // has been granted. A plain UPDATE ... SET deferral_count = deferral_count
  // + 1 RETURNING deferral_count is atomic under concurrent writers by
  // Postgres row-level locking alone — no separate compare-and-swap needed
  // for the increment itself. The 3rd request (returned count > 2) is
  // never granted — it escalates immediately instead. Never derived from
  // message text, so rewording never resets it.
  deferralCount: integer("deferral_count").notNull().default(0),
  // Human-readable reason shown next to StatusBadge whenever status is
  // "escalated" (e.g. "חלפו 3 ימים ללא השלמת המסמכים") — so an employee
  // never has to dig through audit_logs to understand why automation
  // stopped on this request.
  escalationReason: text("escalation_reason"),
});

// The per-cycle snapshot described in BR-002 above — copied from
// serviceDocumentRequirements when the Collection Request is created,
// independent of later edits to (or deletion of) the source template.
export const collectionRequestRequirements = pgTable(
  "collection_request_requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    collectionRequestId: uuid("collection_request_id")
      .notNull()
      .references(() => collectionRequests.id, { onDelete: "cascade" }),
    sourceRequirementId: uuid("source_requirement_id").references(
      () => serviceDocumentRequirements.id,
      { onDelete: "set null" }
    ),
    name: text("name").notNull(),
    description: text("description"),
    // Read by src/lib/documentQuantity.ts's computeRequirementSatisfaction
    // and checkCompletionGate — how many units this requirement needs.
    // Default 1 preserves today's exactly-one-document behavior for every
    // requirement whose semanticSpec (below) is null or has no opinion.
    requiredCount: integer("required_count").notNull().default(1),
    // Semantic requirement engine (src/lib/ai/requirementSemantics.ts) —
    // copied from serviceDocumentRequirements.semanticSpec at snapshot time
    // (snapshotServiceRequirements), with any relative/month-only period
    // resolved into concrete "MM/YYYY" entries anchored to this specific
    // request's own creation date (a reusable Service template has no
    // request date of its own — "last 3 months" only means something once
    // a real request exists). Null when the source had no parsed spec, or
    // for an ad-hoc client-profile addition (Milestone 6) that was never a
    // template requirement at all — computeRequirementSatisfaction falls
    // back to legacy behavior in both cases.
    semanticSpec: jsonb("semantic_spec"),
    // "I don't have this document" exception (src/lib/requirementException.ts)
    // — null for a requirement with no open/decided exception. "reported_missing"
    // is the client's own report, awaiting an office employee's decision;
    // "waived" (computeRequirementSatisfaction treats this exactly like the
    // requirement being fully satisfied, regardless of documents),
    // "will_contact_client", and "left_open" are the employee's other three
    // possible decisions — all three keep the requirement genuinely
    // unsatisfied (a real matching document can still complete it normally
    // later) but suppress automated reminder nagging about it while active.
    // Cleared back to null automatically the moment a real document is
    // approved against this requirement (the client found it after all) or
    // an employee picks "request alternative" (the requirement itself is
    // rewritten instead).
    exceptionStatus: text("exception_status"),
    // The client's own literal wording ("אין לי את אישור השכירות") — shown
    // to the employee verbatim, never paraphrased, alongside the decision.
    exceptionNote: text("exception_note"),
    exceptionCreatedAt: timestamp("exception_created_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  }
);

// EPS Ch.6: Received → Processing → Approved / Rejected / Needs Review,
// plus the Ch.14 manual-deletion-from-Drive reconciliation state.
export const documentStatus = pgEnum("document_status", [
  "received",
  "processing",
  "approved",
  "rejected",
  "needs_review",
  "deleted_from_drive",
  // Ch.6 3-way document intake split — a document the AI identified with
  // real confidence but that doesn't match any of the request's open
  // requirements (e.g. an invoice, sent while only "תעודת זהות" is still
  // outstanding). Held here — not needs_review, not uploaded — while the
  // client is asked whether it was sent on purpose. See
  // src/lib/documentIntakeReview.ts.
  "unsolicited_pending_confirmation",
  // Client confirmed it was intentional — uploaded to the existing client
  // folder as an extra document, never tied to a requirement.
  "unsolicited_approved",
  // Client said it was sent by mistake — never uploaded; pendingFileContent
  // cleared.
  "unsolicited_rejected",
  // The AI couldn't identify the document with enough confidence at all —
  // the client is asked what it is, in their own words.
  "clarification_requested",
  // Smart identity/consistency verification (documentIdentityVerification.ts)
  // — the document's own content (extracted name/ID number) doesn't line up
  // with the client on this request, or with another document already
  // received for it (e.g. a different person's ID, or two documents with
  // different ID numbers). Held here — never uploaded, never needs_review
  // — while the client is asked a question tailored to the specific
  // mismatch found.
  "identity_anomaly_pending_confirmation",
  // Client confirmed the flagged document is correct/intentional anyway —
  // uploaded to the client's folder with an audit trail of the
  // confirmation. Never auto-treated as fulfilling the requirement it
  // doesn't actually match, and never changes the request's primary client.
  "identity_anomaly_confirmed",
  // Client said the document doesn't belong here — never uploaded;
  // pendingFileContent cleared, same retention policy as
  // unsolicited_rejected.
  "identity_anomaly_rejected",
  // Post-completion intent gate (src/lib/requestReopen.ts) — a document
  // arrived on a conversation whose request already completed. Never
  // auto-filed and never auto-reopens the request; held here while the
  // client is asked whether to reopen the (already-finished) request to
  // save it. See caseReview.ts's own "intervention window" doc comment.
  "reopen_pending_confirmation",
  // Client said not to — never uploaded, the completed request stays
  // completed; pendingFileContent cleared, same retention policy as
  // unsolicited_rejected.
  "reopen_declined",
  // Document replace/supersede (src/lib/documentReplace.ts) — the client
  // explicitly said a newer document replaces this one ("זה מחליף את
  // הקודם"). Never deleted — the row and its real Drive file both stay,
  // renamed to make the supersession visible at a glance
  // (markDocumentSupersededInDrive) — just excluded from every
  // active-document count (approved-requirement checks, quantity
  // satisfaction) via documents.supersededByDocumentId being set.
  "superseded",
  // Conversational correction layer (src/lib/correction/) — the client
  // referred back to an already-resolved document (e.g. "שלחתי בטעות" right
  // after it was kept as an extra or attached to a requirement) and the AI
  // confidently classified their intent to withdraw it entirely. Same
  // family as "superseded": never deleted — the row and its real Drive file
  // both stay, renamed to make the withdrawal visible at a glance
  // (markDocumentWithdrawnInDrive), just excluded from every
  // active-document count, same mechanism as "superseded".
  "withdrawn_by_correction",
  // A document arrived while the conversation is in human_control — never
  // auto-classified/auto-uploaded while control is with an employee. Held
  // here (raw bytes in pendingFileContent/pendingFileMimeType, same as
  // reopen_pending_confirmation) until the employee releases control, at
  // which point reprocessHeldHumanControlDocument
  // (src/app/(app)/collections/conversationActions.ts) replays it through
  // the ordinary intake pipeline. No client-facing question is ever asked
  // while stashed this way (unlike reopen_pending_confirmation) — the
  // client already knows an employee is handling this manually.
  "human_control_pending",
]);

// Metadata + a Google Drive file reference (EPS Ch.4/Ch.8 — Drive stores
// the file, Centro stores metadata only). May satisfy zero or one
// Document Requirement (BR-004).
export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  collectionRequestId: uuid("collection_request_id")
    .notNull()
    .references(() => collectionRequests.id, { onDelete: "cascade" }),
  requirementId: uuid("requirement_id").references(
    () => collectionRequestRequirements.id
  ),
  status: documentStatus("status").notNull().default("received"),
  // Internal storage key only — for a real WhatsApp attachment this is
  // derived from the message id (images always: WhatsApp never supplies a
  // real filename for a photo), never something a human typed. NEVER shown
  // directly to a person (office employee, client, AI-generated message,
  // audit description) — see displayLabel below, the one column that's
  // safe to surface. Keep reading/writing this only for Drive/storage
  // bookkeeping.
  fileName: text("file_name").notNull(),
  // The one human-safe label for this document — resolveDocumentDisplayLabel
  // (src/lib/documents/displayLabel.ts) is the single place that reads this
  // (falling back to the matched requirement's own name, then a generic
  // "מסמך שהתקבל" — never to fileName) and the only function any UI,
  // WhatsApp message, AI prompt, or audit description may use to describe a
  // document to a person. Populated once, at intake time
  // (processInboundAttachment), from the AI classifier's own already-computed
  // aiDocumentType (e.g. "תעודת זהות") — never fileName, never a fresh guess.
  // Null for documents received before this column existed, or when the
  // classifier genuinely couldn't identify a type — both fall through to
  // the same resolver, never left showing a raw filename.
  displayLabel: text("display_label"),
  googleDriveFileId: text("google_drive_file_id"),
  // M-WA-4 — real WhatsApp attachments are downloaded once, at receipt
  // time, but only auto-approved documents upload to Drive immediately
  // (BR-11.5: only validated documents are stored in Drive). A document
  // landing as needs_review would otherwise lose its real bytes forever
  // by the time an employee later approves it through reviewDocument —
  // this is where they wait in the meantime. Cleared back to null the
  // moment they're either uploaded (approved) or no longer needed
  // (rejected) — never a long-term store.
  pendingFileContent: bytea("pending_file_content"),
  pendingFileMimeType: text("pending_file_mime_type"),
  // Product Evolution M9 ("Never Lose a Document") — pendingFileContent
  // above is now also the Drive-outage safety net for an *approved*
  // document: reviewDocument/addManualDocument no longer clear it the
  // moment status flips to "approved" — only once uploadDocumentResiliently
  // (src/lib/storage/driveAdapter.ts) confirms the upload actually
  // succeeded. These three columns track that retry lifecycle. Set the
  // first time an approved document's Drive upload fails;
  // driveUploadRetryCount increments on each subsequent retry attempt
  // (src/lib/recurringScheduler.ts's cron tick, alongside the recurring-
  // cycle job); driveRetryExhaustedAt is set once retries pass a sane
  // ceiling, surfacing the document as needing real human attention
  // (Owner Dashboard system health + an audit event) rather than retrying
  // forever. All three are cleared back to null the moment the upload
  // finally succeeds, alongside pendingFileContent itself.
  driveUploadFailedAt: timestamp("drive_upload_failed_at", { withTimezone: true }),
  driveUploadRetryCount: integer("drive_upload_retry_count").notNull().default(0),
  driveRetryExhaustedAt: timestamp("drive_retry_exhausted_at", { withTimezone: true }),
  // Ch.14: when a document is manually deleted from Drive, Centro keeps
  // the database record, flips status to deleted_from_drive, and the UI
  // shows "Deleted manually on DD/MM/YYYY HH:MM" using this timestamp.
  driveDeletedAt: timestamp("drive_deleted_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Webhook idempotency key — Meta can and does redeliver the same webhook
  // event (a slow ack, a transient error on our end) — without this, a
  // redelivered "image" event would insert a second documents row for the
  // exact same WhatsApp message and upload the same file to Drive twice.
  // Null for anything that didn't arrive as a real WhatsApp attachment
  // (manual uploads, the DevTools simulator), so the partial unique index
  // below only constrains real inbound WhatsApp messages against each
  // other. See handleInboundMessage in the webhook route, which checks
  // this before doing any work.
  whatsappMessageId: text("whatsapp_message_id"),
  // Smart identity/consistency verification (documentIdentityVerification.ts)
  // — best-effort fields the vision classifier extracted from the document
  // itself, used only to compare this document against the request's
  // client and its sibling documents (never shown in full anywhere —
  // outbound messages and logs only ever surface the last few digits of
  // an ID number). Null whenever nothing was reliably extractable, or the
  // extraction confidence was too low to trust — never a guess written to
  // the database. extractedIdNumber is digits only (no dashes/spaces).
  extractedPersonName: text("extracted_person_name"),
  extractedIdNumber: text("extracted_id_number"),
  extractedCompanyName: text("extracted_company_name"),
  // Quantity-aware requirement engine (src/lib/documentQuantity.ts) — the
  // dated period this document covers, normalized as "MM/YYYY" (a payslip's
  // or bank statement's own month, an invoice's own date), when the vision
  // model could confidently tell. Null for anything undated or below
  // MIN_PERIOD_EXTRACTION_CONFIDENCE — never a guessed period. Two approved
  // documents for the same multi-unit requirement (collectionRequestRequirements.requiredCount
  // > 1, e.g. "3 תלושי שכר") sharing the same label count as one satisfied
  // unit, not two — see computeRequirementSatisfaction.
  extractedPeriodLabel: text("extracted_period_label"),
  // Multi-signal multi-page detection (src/lib/documentContinuation.ts) —
  // best-effort signals read off the document itself, corroborating (or
  // ruling out) that a later document is another page of this one, beyond
  // just "arrived soon after." All independently nullable — never guessed
  // when not visible on the page.
  extractedReferenceNumber: text("extracted_reference_number"),
  pageNumberCurrent: integer("page_number_current"),
  pageNumberTotal: integer("page_number_total"),
  // Multi-page document merging — set when this row is an additional page
  // of another already-approved document (a burst of photos of one
  // multi-page contract, not several distinct documents), rather than its
  // own independent unit. Only ever considered for a requiredCount=1
  // requirement that already has one approved, non-continuation document —
  // a requirement asking for several distinct units (requiredCount > 1,
  // e.g. "3 תלושי שכר") never merges, since a second matching document
  // there is a genuinely separate unit, not another page of the first. A
  // continuation page is uploaded to the same Drive folder as an extra
  // file (never merged into a single PDF — no PDF-processing dependency
  // exists in this codebase) and excluded everywhere quantity/completion
  // is computed (src/lib/documentQuantity.ts) so it can never inflate a
  // requirement's satisfied count.
  continuationOfDocumentId: uuid("continuation_of_document_id").references((): AnyPgColumn => documents.id),
  // Real single-PDF merging (src/lib/documentMerge.ts) — set only on the
  // HEAD document of a multi-page group (the one continuation pages point
  // back to via continuationOfDocumentId above), once a second page has
  // actually been merged. Points at a SEPARATE Drive file — the merged PDF
  // — distinct from this row's own googleDriveFileId (each raw source page,
  // including the head's own first image, keeps its own individual Drive
  // file too; nothing is ever deleted). This is "the active document" a
  // case reviewer or requirement check should prefer once set.
  // mergedPdfVersion increments each time a later page triggers the same
  // Drive file's content being replaced in place (never a new file — "no
  // duplication"); both null until the first merge happens.
  mergedPdfDriveFileId: text("merged_pdf_drive_file_id"),
  mergedPdfVersion: integer("merged_pdf_version"),
  // Document replace/supersede (src/lib/documentReplace.ts) — set on the
  // OLD document once the client confirms a newer one replaces it; points
  // at the new document. Never set together with continuationOfDocumentId
  // — a document is either a continuation page of another, or superseded
  // by another, never both.
  supersededByDocumentId: uuid("superseded_by_document_id").references((): AnyPgColumn => documents.id),
  // "Centro checks the case, not the document" (caseReview.ts) — a
  // document classified as an identity anomaly, unsolicited, or
  // unrecognized no longer gets its client-facing question asked the
  // moment it arrives. It's held here (status already reflects which of
  // the three; these two columns carry whatever runCaseReview needs to
  // ask about it later) until the client actually signals they're done
  // sending documents — only then does the whole case get reviewed
  // together, once. Both null for every document that was never deferred
  // (approved, or genuinely still mid-classification).
  deferredReviewKind: text("deferred_review_kind"),
  deferredReviewPayload: jsonb("deferred_review_payload"),
}, (table) => [
  uniqueIndex("documents_whatsapp_message_id_idx")
    .on(table.whatsappMessageId)
    .where(sql`${table.whatsappMessageId} is not null`),
]);

// EPS Ch.6: Open → Waiting for Client → Human Control → Closed.
export const conversationStatus = pgEnum("conversation_status", [
  "open",
  "waiting_for_client",
  "human_control",
  "closed",
]);

// Tracks all communication for a Collection Request (EPS Ch.4). BR-003:
// one conversation is associated with one active Collection Request.
export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  collectionRequestId: uuid("collection_request_id")
    .notNull()
    .references(() => collectionRequests.id),
  status: conversationStatus("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Reminder deferral by explicit client commitment (src/lib/reminderDeferral.ts)
  // — set only when the client committed to a genuine future date ("אשלח
  // ביום חמישי", "אשלח ב-15 באוגוסט"), never for a vague short-term promise
  // ("אשלח בערב", still handled by the pre-existing ack-only path with no
  // stored date). While set and still in the future, the scheduler's
  // normal reminderIntervalDays-based staleness check is bypassed entirely
  // — no reminder before this moment, regardless of how long the
  // conversation has been idle. Cleared the moment it's actually acted on
  // (the date arrives and a reminder/completion is triggered) or the
  // request completes early — never left stale once used.
  deferredReminderAt: timestamp("deferred_reminder_at", { withTimezone: true }),
  // The client's own literal wording — kept as the source of truth
  // alongside the resolved instant above, same discipline as
  // RequirementSemanticSpec.originalText.
  deferredReminderOriginalText: text("deferred_reminder_original_text"),
  deferredReminderTimezone: text("deferred_reminder_timezone"),
  // Human-readable Hebrew explanation of what was understood (e.g. "יום
  // חמישי" or "בעוד יומיים, בתאריך 8 באוגוסט") — reused verbatim to build
  // the client-facing confirmation and kept here for audit/debugging.
  deferredReminderReason: text("deferred_reminder_reason"),
  // Reminder-staleness clock (Bug 3 remediation) — set only in
  // evaluateAndPrompt, the sole place a conversation enters
  // "waiting_for_client", and bumped again by scheduler.ts's own atomic
  // claim each time a plain-staleness reminder cycle is consumed.
  // Deliberately NEVER touched by recordInboundMessage — an inbound
  // message (question, wrong document, partial upload) must never reset
  // how long it's been since the last reminder, only conversations.updatedAt
  // (a different, correctly-client-activity-driven concern: the freeform
  // session window and the separate idleOpenConversations inactivity pass)
  // does that.
  reminderAnchorAt: timestamp("reminder_anchor_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Silence-window case review (src/lib/caseReview.ts's
  // runAutomaticCaseStatusReview) — set to "now + 2 minutes" every time a
  // document arrives on an active (non-extension) collection request,
  // pushed forward again by every further document, so a burst of several
  // files never triggers more than one summary. Once genuinely due (no
  // further document arrived in the window), the scheduler sends one
  // consolidated "here's what I got / here's what's still missing"
  // message — this replaces relying on the client ever typing "סיימתי"
  // for an ordinary active request; that phrase is now only meaningful for
  // the separate post-completion extension flow. Cleared (null) the
  // moment it's acted on or the request completes.
  pendingCaseReviewAt: timestamp("pending_case_review_at", { withTimezone: true }),
});

export const messageDirection = pgEnum("message_direction", [
  "inbound",
  "outbound",
]);

// Reuses the audit actor vocabulary: inbound messages are always "client";
// outbound are "ai" (automated) or "employee" (human takeover, BR-6.4).
export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  direction: messageDirection("direction").notNull(),
  senderType: auditActorType("sender_type").notNull(),
  body: text("body").notNull(),
  whatsappMessageId: text("whatsapp_message_id"),
  deliveryStatus: text("delivery_status"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Webhook idempotency/claim tracking — a real production incident showed
// Meta redelivering the same inbound webhook up to 4 times when a single
// attempt's AI classification call ran long enough to hit the route's
// maxDuration (Vercel killing the function before it could respond 2xx).
// documents.whatsappMessageId alone wasn't enough to prevent this: it's
// only written once a document row is successfully inserted, at the very
// END of the (slow) classification pipeline, so a retry arriving *while*
// the first attempt is still mid-flight sails right past that check and
// reprocesses from scratch — redundant AI calls, and (since inbound
// `messages` rows carried no WhatsApp message id at all) duplicate message-
// log entries too. This table claims the message id atomically as the
// very first thing the webhook does, before any expensive work.
//
// "processing" is deliberately a combined received+claimed+in-flight
// state — the unique claim row's mere existence already proves both
// "received" and "claimed" happened atomically together; there's no
// separate window between them worth its own persisted state. A
// "processing" row older than a bounded staleness window (see
// webhookIdempotency.ts's CLAIM_STALE_MS) is treated as an abandoned/
// crashed attempt and may be reclaimed — a claim can never permanently
// block reprocessing just because the attempt that made it died.
export const webhookClaimStatus = pgEnum("webhook_claim_status", [
  "processing",
  "completed",
  "failed",
]);

export const webhookMessageClaims = pgTable(
  "webhook_message_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    whatsappMessageId: text("whatsapp_message_id").notNull(),
    status: webhookClaimStatus("status").notNull().default("processing"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Never a stack trace (could carry sensitive request data) — just
    // enough to see in the audit trail that a specific message genuinely
    // failed processing and was retried, per "never hide a failure."
    lastError: text("last_error"),
  },
  (table) => [uniqueIndex("webhook_message_claims_whatsapp_message_id_idx").on(table.whatsappMessageId)]
);

export const pendingConfirmationStatus = pgEnum("pending_confirmation_status", [
  "pending",
  "confirmed",
  "declined",
]);

// Milestone 5 — Architecture Ch.3's "Confirm with the client, through
// WhatsApp" step, generalized into reusable infrastructure. Deliberately
// domain-agnostic: `kind` + `payload` let a caller (this milestone's own
// manual trigger; Milestone 6's automatic document-profile detection
// later) attach whatever meaning it needs without this table knowing
// anything about documents, business types, or any other domain. One row
// per question actually asked — never speculative, never asked more than
// once for the same thing (Ch.4: "asked only once").
export const pendingConfirmations = pgTable("pending_confirmations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  collectionRequestId: uuid("collection_request_id")
    .notNull()
    .references(() => collectionRequests.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  // Stable machine-readable identity for whatever this confirmation is
  // about, e.g. "document_profile_addition" — the domain-specific
  // handler (not this table) is what actually reacts to a resolved
  // status.
  kind: text("kind").notNull(),
  payload: jsonb("payload"),
  question: text("question").notNull(),
  status: pendingConfirmationStatus("status").notNull().default("pending"),
  responseText: text("response_text"),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Reminder/escalation for the two document-intake kinds
  // (unsolicited_document / document_clarification — see
  // src/lib/documentIntakeReview.ts). Unused (stays 0/null) by the
  // existing document_profile_* kinds, which were never reminded before
  // this and still aren't. nextReminderAt null means "nothing scheduled" —
  // either never configured, or remindersSent has already reached the
  // organization's confirmationMaxReminders and escalatedAt is set instead.
  remindersSent: integer("reminders_sent").notNull().default(0),
  nextReminderAt: timestamp("next_reminder_at", { withTimezone: true }),
  // Set once, the moment the reminder budget is exhausted with no reply —
  // the scheduler's signal to stop reminding and hand the linked document
  // to needs_review, and a guard against escalating (or reminding) twice.
  escalatedAt: timestamp("escalated_at", { withTimezone: true }),
  // Smart notification grouping (src/lib/pendingConfirmations.ts's
  // flushDueIntakeNotifications) — several documents/anomalies arriving in
  // a short burst must reach the client as ONE combined WhatsApp message,
  // never one per file. A row created in "batched" mode (unsolicited_document
  // / identity_anomaly) starts with notifyAfter set and notifiedAt/
  // groupIndex null — held, not sent — until the grouping window elapses,
  // at which point every still-unnotified row for the same collection
  // request is flushed together: each gets a groupIndex (its 0-based
  // position in the combined message, which is also what the numbered
  // reply options 2*i+1 / 2*i+2 refer to) and notifiedAt is stamped.
  // Both stay null for the two document_profile_* kinds and
  // document_clarification, which are unaffected by this and still send
  // immediately exactly as before.
  notifyAfter: timestamp("notify_after", { withTimezone: true }),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  groupIndex: integer("group_index"),
}, (table) => [
  // Phase 4.6 remediation — createExtensionFinishedCheckIfDue
  // (src/lib/requestExtension.ts) read-then-inserts: it lists open
  // confirmations, then inserts if none match. Two overlapping calls for
  // the same collection request could both pass that read before either
  // insert commits, opening a second "סיימת להעלות?" question the client
  // never should have gotten twice. Existence-only (no value to
  // compare-and-swap against), so a plain partial unique index closes the
  // race at the database instead of a claim pattern — the second insert
  // fails with a unique violation that the caller catches as a no-op.
  uniqueIndex("pending_confirmations_extension_finished_check_idx")
    .on(table.collectionRequestId)
    .where(sql`${table.kind} = 'extension_finished_check' and ${table.status} = 'pending'`),
]);

// Multi-active-collection-request disambiguation — a client can genuinely
// have two or more collection requests open at once (e.g. assigned to two
// different recurring Services, or a second request opened manually while
// an earlier one is still waiting on documents). When that happens, an
// inbound WhatsApp message/document has no reliable signal (phone number
// alone identifies the CLIENT, never which of their several open requests
// a given message is about) — picking "whichever conversation was most
// recently updated" would silently guess, and a wrong guess can mark the
// wrong request's requirement satisfied or auto-complete the wrong
// request. This table is the held state for that one narrow situation:
// the real content (text and/or attachment) the client actually sent is
// captured here — NOT attached to any collectionRequestId yet, since we
// don't know which one it belongs to — while Centro asks the client
// directly which of their open requests this is about. Nothing about any
// candidate request (documents, requirements, completion, reminders) is
// touched until resolved. See src/lib/requestDisambiguation.ts.
export const pendingRequestDisambiguations = pgTable(
  "pending_request_disambiguations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    // The genuinely-open collection requests this message could belong to,
    // captured at the moment the question was asked — never re-queried
    // live, so a request completing/cancelling while the client is still
    // deciding doesn't change the numbered options they were already sent.
    candidateCollectionRequestIds: jsonb("candidate_collection_request_ids").$type<string[]>().notNull(),
    // One of the candidates above, used only as the messages/conversations
    // row to log the clarification question itself against — never implies
    // that request is the answer; the client's reply is what actually
    // resolves it.
    hostConversationId: uuid("host_conversation_id")
      .notNull()
      .references(() => conversations.id),
    // The held content — same retention discipline as documents.pendingFileContent
    // (Ch.14/M9): raw bytes captured once at receipt time (a WhatsApp media
    // URL is short-lived and may not still resolve by the time the client
    // answers), cleared the moment this row resolves.
    messageBody: text("message_body"),
    pendingFileName: text("pending_file_name"),
    pendingFileContent: bytea("pending_file_content"),
    pendingFileMimeType: text("pending_file_mime_type"),
    // Idempotency for a redelivered webhook while this exact question is
    // still open — mirrors documents.whatsappMessageId's own role.
    whatsappMessageId: text("whatsapp_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedCollectionRequestId: uuid("resolved_collection_request_id").references(
      () => collectionRequests.id
    ),
  },
  (table) => [
    // At most one open question per client at a time — a second inbound
    // message while one is already pending is treated as an attempt to
    // answer it (see resolveDisambiguationReply), never a second question.
    uniqueIndex("pending_request_disambiguations_client_open_idx")
      .on(table.clientId)
      .where(sql`${table.resolvedAt} is null`),
  ]
);

// Confirmed durable conversational focus (conversation-intelligence design,
// 2026-08) — which of a client's several open collection requests the
// conversation is currently about. Deliberately holds ONLY authoritative
// state: a row here is written exclusively by an explicit, unambiguous
// signal (the trivial single-open-request case, a resolved numbered
// disambiguation reply, or an explicit client topic switch) — never by a
// bare LLM inference. An LLM's own hypothesis about focus is derived state,
// recomputed fresh every turn from this row + recent conversation; it is
// never persisted here and never treated as fact on its own. One row per
// client — always the CURRENT confirmed focus, not a history (audit_logs
// already records every change via whichever action set it).
export const conversationFocusSource = pgEnum("conversation_focus_source", [
  "single_open_request",
  "disambiguation_reply",
  "explicit_switch",
]);

export const clientConversationFocus = pgTable(
  "client_conversation_focus",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    collectionRequestId: uuid("collection_request_id")
      .notNull()
      .references(() => collectionRequests.id, { onDelete: "cascade" }),
    source: conversationFocusSource("source").notNull(),
    setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("client_conversation_focus_client_idx").on(table.clientId)]
);

// Unified document-conversation understanding layer (src/lib/conversation/,
// src/lib/employeeReview.ts, src/lib/policyKnowledgeBase.ts) — "the AI
// understands, the office decides, and only an explicit office decision
// ever becomes reusable knowledge."
//
// employeeReviewItems: the generic, non-blocking "this needs an office
// decision" queue. Created whenever the AI understands a document-related
// question/request it has no confident authority to answer alone (a
// proposed alternative document, a validity/format question, a request to
// talk to a person, or any other future scenario — never a fixed sentence
// list). Opening one never pauses the rest of the conversation — the client
// gets an immediate natural reply and can keep sending documents, asking
// what's missing, correcting mistakes, etc. while this one specific
// question waits. See src/lib/employeeReview.ts.
export const reviewItemCategory = pgEnum("review_item_category", [
  "missing_document",
  "alternative_or_policy_question",
  "human_request",
  "other",
]);
export const reviewItemStatus = pgEnum("review_item_status", ["pending", "resolved"]);
// Who/what actually resolved a review item — required for a clear audit
// trail whenever the conversational layer closes one on its own (see
// src/lib/employeeReview.ts's closeReviewItemFromClientContext), never
// inferred after the fact from resolvedByUserId being null.
export const reviewItemResolvedBy = pgEnum("review_item_resolved_by", ["employee", "ai_context"]);

export const employeeReviewItems = pgTable("employee_review_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  collectionRequestId: uuid("collection_request_id").references(() => collectionRequests.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  // The client's own literal wording — never paraphrased, same discipline
  // as collectionRequestRequirements.exceptionNote.
  clientQuestion: text("client_question").notNull(),
  category: reviewItemCategory("category").notNull(),
  // AI-produced structured summary of what was understood — e.g.
  // { relatedRequirementName: string | null, gist: string } — shown to the
  // employee ALONGSIDE clientQuestion, never in place of it; never
  // authoritative on its own.
  understoodContext: jsonb("understood_context"),
  relatedRequirementId: uuid("related_requirement_id").references(() => collectionRequestRequirements.id, {
    onDelete: "set null",
  }),
  status: reviewItemStatus("status").notNull().default("pending"),
  resolutionText: text("resolution_text"),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  // Null while pending. Set alongside status/resolutionText/resolvedAt on
  // every resolution path — "employee" for a real dashboard decision,
  // "ai_context" when the conversational layer recognized (at a high,
  // confidence-gated bar) that a later client message made the question
  // moot. resolutionText for an "ai_context" resolution is an
  // internal/audit explanation, never sent to the client verbatim (the
  // client instead gets the classifier's own natural acknowledgment — see
  // conversationDispatch.ts).
  resolvedBy: reviewItemResolvedBy("resolved_by"),
  // A running, append-only log of later client messages relevant to this
  // item that didn't (yet, or ever) resolve it outright — e.g. the client
  // added a detail while the item is still pending, or commented on it
  // after an employee already answered. Each entry:
  // { note: string, clientMessage: string, at: string (ISO) }. Never
  // removes or rewrites clientQuestion/resolutionText — purely additive,
  // so an employee always sees the full history, never a silently
  // overwritten question.
  contextUpdates: jsonb("context_updates"),
  // Opt-in promote-to-policy trace — becamePolicy is only ever true
  // together with a real policyId, both set in the same resolution
  // transaction (resolveEmployeeReviewItem). Never set automatically; the
  // office employee must explicitly check a box at resolution time. policyId
  // has no DB-level FK (approvedPolicies is declared after this table to
  // let IT hold the real FK back here via sourceReviewItemId instead) — app-
  // enforced only, always written in the same transaction that creates the
  // approvedPolicies row.
  becamePolicy: boolean("became_policy").notNull().default(false),
  policyId: uuid("policy_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
},
  (table) => [
    // ESCALATE dedup (Phase 4, conversation-intelligence redesign) — a
    // retry/redelivery of the same inbound message re-runs reasoning with
    // the exact same clientQuestion text; this is the real, race-safe
    // guarantee (not just an application-level check-then-insert) that a
    // second attempt can never open a second pending review item for the
    // same still-open question on the same request. Same pattern as
    // pending_request_disambiguations_client_open_idx. A client asking a
    // genuinely new question (even if superficially similar) always has
    // different literal wording, so this never suppresses a real second
    // question — only an exact-text retry of one already pending.
    uniqueIndex("employee_review_items_open_question_idx")
      .on(table.collectionRequestId, table.clientQuestion)
      .where(sql`${table.status} = 'pending'`),
  ]
);

// approvedPolicies: the searchable, semantic "office knowledge" store this
// queue feeds. A policy is NEVER created automatically — only when an
// employee resolving a review item explicitly opts in ("לשמור את ההחלטה
// הזאת כמדיניות למקרים דומים בעתיד?"). Matched against a NEW client
// question by meaning, not literal wording (src/lib/policyKnowledgeBase.ts),
// using the same "real candidate id, never invented" AI discipline used
// throughout this codebase.
export const approvedPolicies = pgTable("approved_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  // The generic, self-contained statement of the QUESTION this policy
  // answers — written broadly enough to match future differently-worded
  // questions by meaning (e.g. "אפשר לשלוח צילום מסמך במקום סריקה?").
  questionSummary: text("question_summary").notNull(),
  // The office's actual decision, in the employee's own words — woven into
  // a natural client-facing reply by renderPolicyAnswer. Never AI-authored.
  decisionText: text("decision_text").notNull(),
  // Loose, optional scoping hint for context/display — not a hard filter.
  relatedDocumentType: text("related_document_type"),
  category: reviewItemCategory("category").notNull(),
  // Soft-retire — "mark, never delete" convention, same as every other
  // status-driven exclusion in this codebase. An inactive policy is
  // excluded from future semantic matching but stays visible for audit.
  isActive: boolean("is_active").notNull().default(true),
  // Real FK — employeeReviewItems is declared above, so this direction is
  // safe. Nullable for a possible future directly-authored policy path.
  sourceReviewItemId: uuid("source_review_item_id").references(() => employeeReviewItems.id, { onDelete: "set null" }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  retiredByUserId: uuid("retired_by_user_id").references(() => users.id, { onDelete: "set null" }),
});

export const clientDocumentRequirementAction = pgEnum(
  "client_document_requirement_action",
  ["add", "remove"]
);
export const clientDocumentRequirementStatus = pgEnum(
  "client_document_requirement_status",
  ["pending", "confirmed", "declined"]
);

// Milestone 6 ("Adaptive Document Collection") — Architecture Ch.8's one
// permitted kind of learning, made real: per-client deviations from the
// service's document-requirement template. Never touches the template
// itself (services.serviceDocumentRequirements, shared across every
// client of that business type) — an addition or removal here only ever
// affects the one client it was confirmed for.
//
// A row starts `pending` the moment a pattern is *observed* (a document
// type recurring, or a requirement going unsatisfied for two consecutive
// post-Learning-Mode cycles) — never `confirmed` on its own. Only the
// client's own reply (via src/lib/pendingConfirmations.ts) moves it to
// `confirmed` or `declined`; nothing here ever assumes.
export const clientDocumentRequirements = pgTable(
  "client_document_requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    action: clientDocumentRequirementAction("action").notNull(),
    // Display name either way — the new document type's name for "add",
    // or the existing requirement's name (denormalized for display) for
    // "remove".
    name: text("name").notNull(),
    // "remove" only — which template requirement this client's copy is
    // being suppressed from. Null for "add": a client-specific addition
    // has no service-wide template row to point back to.
    sourceRequirementId: uuid("source_requirement_id").references(
      () => serviceDocumentRequirements.id,
      { onDelete: "cascade" }
    ),
    // How many times this pattern has been observed — an addition is only
    // ever suggested on its second occurrence (Ch.3: never from a single
    // event).
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    status: clientDocumentRequirementStatus("status").notNull().default("pending"),
    pendingConfirmationId: uuid("pending_confirmation_id").references(
      () => pendingConfirmations.id,
      { onDelete: "set null" }
    ),
    // Semantic requirement engine (src/lib/ai/requirementSemantics.ts) —
    // an "add" row predates this engine (Milestone 6 shipped before it
    // existed) and was always given a hardcoded semanticSpec:null,
    // requiredCount:1 at snapshot time (resolveEffectiveRequirementNames),
    // never actually parsed. Parsed here instead, honestly, at the moment
    // the client confirms the addition (applyDocumentProfileConfirmation)
    // — never blocking (same non-blocking-on-low-confidence discipline as
    // createCollectionRequestDraft's bulk wizard step in
    // templates/actions.ts), so "2 תלושי שכר אחרונים" now gets real
    // quantity/period understanding instead of being silently flattened to
    // "exactly one document, no period." Null for a "remove" row (no
    // requirement text of its own to parse) or a row confirmed before this
    // column existed.
    semanticSpec: jsonb("semantic_spec"),
    requiredCount: integer("required_count").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("client_document_requirements_client_name_action_idx").on(
      table.clientId,
      table.name,
      table.action
    ),
  ]
);

// Feature: Centro-to-lead outbound WhatsApp messaging (src/app/api/contact/
// route.ts). Deliberately NOT organization-scoped — unlike every other
// table in this file, a lead is Centro's own sales prospect, not a
// customer organization's data. Persisted (previously the contact form
// only emailed, with no DB write at all) so there's an auditable record
// independent of email deliverability, and so a WhatsApp send failure has
// somewhere to record the outcome for follow-up/retry.
export const leadWhatsappStatus = pgEnum("lead_whatsapp_status", [
  "not_applicable", // phone failed E.164 normalization — never attempted
  "pending",
  "sent",
  "failed",
]);

export const leads = pgTable("leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // Raw as submitted (the contact form's own loose validation shape) —
  // kept even when E.164 normalization fails, for manual follow-up.
  phone: text("phone").notNull(),
  phoneE164: text("phone_e164"),
  email: text("email"),
  businessName: text("business_name"),
  message: text("message"),
  source: text("source").notNull(),
  emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
  whatsappStatus: leadWhatsappStatus("whatsapp_status").notNull().default("pending"),
  whatsappMessageId: text("whatsapp_message_id"),
  whatsappError: text("whatsapp_error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// In-app Support screen — replaces the old "תמיכה" nav item's direct
// WhatsApp deep-link with a real internal request captured here first, so
// a transient email outage never loses a request the way a pure
// email-only flow would (mirrors `leads` above: persist regardless of
// delivery, record delivery outcome separately). `ticketNumber` is a
// real Postgres-generated sequential integer (not a client-side/cosmetic
// value) — the human-facing "#XXXX" shown in the UI is this column, never
// the internal uuid `id`.
export const supportRequestCategory = pgEnum("support_request_category", [
  "not_working",
  "google_drive",
  "whatsapp",
  "question",
  "feature_request",
  "other",
]);

export const supportRequestDeliveryStatus = pgEnum("support_request_delivery_status", [
  "pending",
  "sent",
  "failed",
]);

export const supportRequests = pgTable("support_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  ticketNumber: serial("ticket_number").notNull(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  // set null (not restrict/cascade) on user delete, same reasoning as
  // audit_logs.actorUserId — a deleted employee must never block cleanup
  // just because they once filed a support request. userName/userEmail
  // below are snapshotted at creation time precisely so the request stays
  // meaningful for support triage even after that.
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  userName: text("user_name"),
  userEmail: text("user_email").notNull(),
  organizationName: text("organization_name").notNull(),
  category: supportRequestCategory("category").notNull(),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  // Client-reported context only (current page, browser timezone) — never
  // used for authorization or identity, purely informational for whoever
  // triages the request.
  currentPage: text("current_page"),
  timezone: text("timezone"),
  deliveryStatus: supportRequestDeliveryStatus("delivery_status").notNull().default("pending"),
  emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
  emailError: text("email_error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- AI Core: internal employee <-> Centro AI copilot conversations ---
// Deliberately separate from `conversations`/`messages` above: those
// model a WhatsApp conversation about a specific collection request for
// a specific client (both FKs NOT NULL) and carry no role/tool-call
// shape — a poor fit for a general-purpose employee<->AI chat that has
// neither a client nor a collection request. See src/lib/aiCore/ for the
// engine that reads/writes these tables.
export const aiConversationStatus = pgEnum("ai_conversation_status", [
  "active",
  "archived",
]);

export const aiConversations = pgTable("ai_conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Null until derived from the first user message (memory/persistence.ts)
  // — renders as a generic "New conversation" until then.
  title: text("title"),
  status: aiConversationStatus("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const aiMessageRole = pgEnum("ai_message_role", [
  "system",
  "user",
  "assistant",
  "tool",
]);

// One row per provider ModelMessage, not per turn — an assistant turn
// that calls tools produces an assistant row (the tool call) and one or
// more tool rows (the tool result) before any final text, in call order.
export const aiMessages = pgTable("ai_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => aiConversations.id, { onDelete: "cascade" }),
  role: aiMessageRole("role").notNull(),
  // Display-only plain text for the chat UI — extracted from `parts`
  // (a string content is used as-is; a content-part array is reduced to
  // its text parts, joined). Null on a role="tool" row or a role=
  // "assistant" row that made only tool calls with no text.
  content: text("content"),
  // The exact { role, content } the provider SDK produced or expects —
  // content may be a plain string or an array of text/tool-call/tool-
  // result parts (AssistantModelMessage/ToolModelMessage's own shape).
  // `content` above is a lossy display projection of this; `parts` is
  // what memory/persistence.ts replays verbatim into the next turn's
  // `messages` array, so history reconstruction is never lossy.
  parts: jsonb("parts").notNull(),
  // Set only on role="assistant" rows — which provider/model produced
  // this reply, for observability and so a follow-up turn can resolve
  // back to the same provider (see providers/resolveModel.ts).
  provider: text("provider"),
  modelId: text("model_id"),
  // Token usage / finishReason — observability only, never read by the
  // agent loop itself.
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Owner Dashboard (internal, platform-owner-only — see
// docs/plans or the owner-dashboard plan for full rationale). Deliberately
// separate from `users`/`sessions`/`organizations`: the platform owner is
// not a tenant, and `sessions.organizationId`/`Session.organizationId` are
// non-nullable, so folding the owner into that model would either need a
// dummy internal organization or a nullability change on the app's hottest
// read path. These three tables are the same recipe as `users`/`sessions`/
// `auditLogs` with the org dimension removed, kept additive and isolated.
export const platformOwners = pgTable("platform_owners", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Same shape as `sessions`, minus organizationId — opaque random id stored
// server-side, cookie holds only the id. Provisioned exclusively via
// scripts/create-owner.ts; there is no self-registration route.
export const platformOwnerSessions = pgTable("platform_owner_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  platformOwnerId: uuid("platform_owner_id")
    .notNull()
    .references(() => platformOwners.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// Distinguishes events a future alerting mechanism should surface
// ("warning"/"critical") from routine activity ("info") — the hook the
// Owner Dashboard's later System Health phase is designed around, so
// adding real alert delivery afterward needs no schema change.
export const platformOwnerAuditSeverity = pgEnum(
  "platform_owner_audit_severity",
  ["info", "warning", "critical"]
);

// Mirrors `auditLogs`' insert-only design (no update/delete path) without
// its organizationId FK, which is NOT NULL there and can't represent an
// ownerless actor. Records the owner's own actions on the platform (login,
// logout, and later account-lifecycle actions like suspend/reactivate).
export const platformOwnerAuditLog = pgTable("platform_owner_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  occurredAt: timestamp("occurred_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  eventType: text("event_type").notNull(),
  severity: platformOwnerAuditSeverity("severity").notNull().default("info"),
  // set null (not restrict) on delete, matching auditLogs.actorUserId's
  // precedent — this is an observability trail, not business data.
  platformOwnerId: uuid("platform_owner_id").references(() => platformOwners.id, {
    onDelete: "set null",
  }),
  description: text("description").notNull(),
  metadata: jsonb("metadata"),
});

// Per-organization WhatsApp message templates managed from the owner
// screen: composed here, submitted to that organization's OWN WABA with
// that organization's OWN access token, and tracked through Meta's review.
//
// Deliberately separate from src/lib/whatsapp/templates.ts's
// REQUIRED_TEMPLATES (the pre-existing, code-defined templates the send
// path actually uses today, gated by organizations.initialRequestV2Approved
// / reminderV2Approved). Nothing here feeds the live send path yet — this
// table is the tracking/management layer, so introducing it cannot change
// which template an organization actually sends.
export const whatsappTemplates = pgTable(
  "whatsapp_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Denormalized from organizations.whatsappBusinessAccountId at
    // submission time, on purpose: a template lives on ONE specific WABA,
    // and if the organization ever reconnects to a different WABA, rows
    // recorded against the old one must stay attributable to it rather
    // than silently appearing to belong to the new one.
    wabaId: text("waba_id").notNull(),
    name: text("name").notNull(),
    language: text("language").notNull(),
    category: text("category").notNull(),
    bodyText: text("body_text").notNull(),
    // The positional placeholders this body declares, in order (["{{1}}"]),
    // and one example value per placeholder — Meta rejects a parameterized
    // template outright (INVALID_FORMAT) without examples.
    variables: jsonb("variables").notNull(),
    exampleValues: jsonb("example_values").notNull(),
    // Meta's own id for the submitted template, returned on a successful
    // create. Null until a submission actually succeeds; it's what the
    // "resubmit a rejected template" path edits (POST /{template-id}),
    // since Meta refuses a second create under the same name.
    metaTemplateId: text("meta_template_id"),
    // Meta's own review vocabulary (PENDING / APPROVED / REJECTED, plus
    // PAUSED / DISABLED / IN_APPEAL / PENDING_DELETION), stored verbatim
    // as text rather than a pgEnum: this is an external system's
    // vocabulary that Meta can extend at will, and an unrecognized value
    // must be recorded honestly, never dropped or crash an insert.
    // "LOCAL_DRAFT" is Centro's own value for a row composed here but not
    // yet submitted.
    status: text("status").notNull().default("LOCAL_DRAFT"),
    // Meta's rejected_reason verbatim (e.g. INVALID_FORMAT), null unless
    // the current status is REJECTED.
    rejectedReason: text("rejected_reason"),
    // When Meta was last actually asked about this template's status —
    // distinct from updatedAt, which also moves on local edits.
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    // When this template was last successfully EDITED in Meta (distinct
    // from lastSyncedAt, which also moves on a read-only status refresh).
    // Meta allows an approved template one edit per 24 hours; this is what
    // lets the screen say "ניתן לערוך שוב מחר" instead of letting the
    // owner discover the limit as an API error.
    lastEditedAt: timestamp("last_edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Tenant isolation at the database, not just in queries: one
    // organization can hold exactly one row per template name+language, and
    // two organizations' rows can never collide with each other.
    uniqueIndex("whatsapp_templates_org_name_language_idx").on(
      table.organizationId,
      table.name,
      table.language
    ),
  ]
);

export const jobRunStatus = pgEnum("job_run_status", ["success", "failed"]);

// System Health foundation — previously the cron tick (POST /api/cron/tick)
// returned its {evaluated, reminded, delivered} counts in the HTTP response
// only, with nothing persisted; there was no way to answer "did last
// night's tick run, and did it fail" after the fact. One row per tick.
export const jobRuns = pgTable("job_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobName: text("job_name").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
  status: jobRunStatus("status").notNull(),
  // On success: the task's own returned counts. On failure: an error
  // message. Observability only, same spirit as aiMessages.metadata.
  resultSummary: jsonb("result_summary"),
});
