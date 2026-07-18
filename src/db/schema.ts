import {
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// The Pilot MVP uses a single shared employee account per firm (EPS Ch.13
// BR-13.1) rather than individual employee identities — one row per
// Organization, created alongside it (see scripts/create-organization.ts).
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
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
