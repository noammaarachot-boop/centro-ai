ALTER TABLE "organizations" ADD COLUMN "document_grouping_window_seconds" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_confirmations" ADD COLUMN "notify_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pending_confirmations" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pending_confirmations" ADD COLUMN "group_index" integer;