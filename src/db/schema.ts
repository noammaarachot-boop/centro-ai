import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Owns all configuration, users and (starting M3) clients/services/collection
// data. EPS Ch.2 PR-005 / Ch.8: every other table is scoped to one of these.
//
// The three *ConnectedAt / *ActivatedAt columns track the Ch.3 onboarding
// gate (BR-001: "Automation cannot be activated until all mandatory
// integrations are connected"). Google/WhatsApp connection is mocked for
// now (M5/M6 wire real OAuth) — a timestamp is set directly by the
// onboarding UI instead of a real callback, but the gating logic against
// these columns is the real, permanent logic.
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  googleConnectedAt: timestamp("google_connected_at", { withTimezone: true }),
  whatsappConnectedAt: timestamp("whatsapp_connected_at", {
    withTimezone: true,
  }),
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
