ALTER TABLE "organizations" ADD COLUMN "business_hours_start" text DEFAULT '09:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "business_hours_end" text DEFAULT '18:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "business_days" text DEFAULT '0,1,2,3,4' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "reminder_interval_days" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "inactivity_timeout_minutes" integer DEFAULT 15 NOT NULL;