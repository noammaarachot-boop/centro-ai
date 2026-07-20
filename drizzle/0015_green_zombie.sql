ALTER TABLE "clients" ADD COLUMN "imported_during_onboarding" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "collection_day_of_month" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "collection_day_of_month_override" integer;