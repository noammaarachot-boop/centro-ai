import {
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Owns all configuration, users and (starting M3) clients/services/collection
// data. EPS Ch.2 PR-005 / Ch.8: every other table is scoped to one of these.
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
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
  actorUserId: uuid("actor_user_id").references(() => users.id),
  description: text("description").notNull(),
  metadata: jsonb("metadata"),
});
