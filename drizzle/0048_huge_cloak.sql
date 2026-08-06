ALTER TABLE "conversations" ADD COLUMN "deferred_reminder_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "deferred_reminder_original_text" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "deferred_reminder_timezone" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "deferred_reminder_reason" text;