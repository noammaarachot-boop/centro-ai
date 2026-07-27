CREATE TYPE "public"."service_collection_mode" AS ENUM('recurring', 'on_demand');--> statement-breakpoint
ALTER TYPE "public"."workflow_type" ADD VALUE 'on_demand';--> statement-breakpoint
ALTER TYPE "public"."workflow_type" ADD VALUE 'both';--> statement-breakpoint
ALTER TABLE "client_services" ADD COLUMN "next_collection_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "classification_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "drive_upload_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "drive_upload_retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "drive_retry_exhausted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "automation_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "collection_mode" "service_collection_mode" DEFAULT 'on_demand' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "collection_frequency_interval_months" integer;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "automation_paused_at" timestamp with time zone;--> statement-breakpoint
-- Data backfill (Product Evolution M9): every existing Service that backs a
-- Business Type (business_types.service_id) was, under the pre-M9 model,
-- exactly what "recurring" meant — carry that forward explicitly instead of
-- leaving it at the new column's generic "on_demand" default. Every other
-- existing Service (a Workflow-B Template) keeps the default, which is
-- exactly what it already was.
UPDATE "services" SET "collection_mode" = 'recurring', "collection_frequency_interval_months" = 1
WHERE "id" IN (SELECT "service_id" FROM "business_types");--> statement-breakpoint
-- Any client already carrying a business_type_id was already fully wired
-- into a real clientServices assignment under the pre-M9 model (see
-- assignClientsToBusinessType) — that's already exactly what a "confirmed"
-- classification means going forward, so mark it as such rather than
-- having every existing classified client show up as "awaiting approval".
UPDATE "clients" SET "classification_confirmed_at" = now() WHERE "business_type_id" IS NOT NULL;