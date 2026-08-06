ALTER TABLE "documents" ADD COLUMN "extracted_reference_number" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "page_number_current" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "page_number_total" integer;