ALTER TABLE "documents" ADD COLUMN "pending_file_content" "bytea";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "pending_file_mime_type" text;