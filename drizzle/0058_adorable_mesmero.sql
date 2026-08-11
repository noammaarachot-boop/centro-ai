ALTER TABLE "collection_requests" ADD COLUMN "review_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collection_requests" ADD COLUMN "deferral_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_requests" ADD COLUMN "escalation_reason" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "reminder_anchor_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "reminder_interval_hours" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "reminder_interval_hours_override" integer;