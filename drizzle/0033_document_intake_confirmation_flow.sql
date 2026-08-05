ALTER TYPE "public"."document_status" ADD VALUE 'unsolicited_pending_confirmation';--> statement-breakpoint
ALTER TYPE "public"."document_status" ADD VALUE 'unsolicited_approved';--> statement-breakpoint
ALTER TYPE "public"."document_status" ADD VALUE 'unsolicited_rejected';--> statement-breakpoint
ALTER TYPE "public"."document_status" ADD VALUE 'clarification_requested';--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "confirmation_max_reminders" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_confirmations" ADD COLUMN "reminders_sent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_confirmations" ADD COLUMN "next_reminder_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pending_confirmations" ADD COLUMN "escalated_at" timestamp with time zone;