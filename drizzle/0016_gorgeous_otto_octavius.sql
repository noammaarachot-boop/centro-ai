CREATE TYPE "public"."workflow_type" AS ENUM('recurring', 'one_time');--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "business_category" text DEFAULT 'accountant' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "business_category_custom_label" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "workflow_type" "workflow_type" DEFAULT 'recurring' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone" text;