import {
  boolean,
  customType,
  integer,
  jsonb,
  pgEnum,
  pgTable,
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

// Product Evolution M1: the permanent fork chosen once during onboarding
// between the existing recurring/learning workflow and the new one-time/
// template-driven workflow. Defaults to "recurring" so every pre-existing
// organization keeps its exact current behavior with zero migration risk.
// Not exposed as an editable Settings toggle — switching later is a data
// migration question, out of scope unless explicitly requested.
export const workflowTypeEnum = pgEnum("workflow_type", ["recurring", "one_time"]);

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
  reminderIntervalDays: integer("reminder_interval_days").notNull().default(2),
  inactivityTimeoutMinutes: integer("inactivity_timeout_minutes")
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
  // Epic 3: per-business-type reminder/business-hours overrides, set from
  // the onboarding wizard's Reminder Rules step (or later from this
  // service's own page). Null = "use the organization's default" — see
  // resolveScheduleConfig() in src/lib/businessHours.ts, the single place
  // that resolves these against organizations' equivalent columns. Every
  // service created before Epic 3 has all five null, so scheduler.ts and
  // conversationOrchestration.ts behave exactly as before for it.
  reminderIntervalDaysOverride: integer("reminder_interval_days_override"),
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
  fileName: text("file_name").notNull(),
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
});

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
