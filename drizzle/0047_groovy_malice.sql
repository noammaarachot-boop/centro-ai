ALTER TABLE "collection_request_requirements" ADD COLUMN "exception_status" text;--> statement-breakpoint
ALTER TABLE "collection_request_requirements" ADD COLUMN "exception_note" text;--> statement-breakpoint
ALTER TABLE "collection_request_requirements" ADD COLUMN "exception_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collection_requests" ADD COLUMN "extension_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "merged_pdf_drive_file_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "merged_pdf_version" integer;