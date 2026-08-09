CREATE TYPE "public"."review_item_resolved_by" AS ENUM('employee', 'ai_context');--> statement-breakpoint
ALTER TABLE "employee_review_items" ADD COLUMN "resolved_by" "review_item_resolved_by";--> statement-breakpoint
ALTER TABLE "employee_review_items" ADD COLUMN "context_updates" jsonb;