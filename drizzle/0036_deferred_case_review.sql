ALTER TABLE "documents" ADD COLUMN "deferred_review_kind" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "deferred_review_payload" jsonb;