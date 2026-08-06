ALTER TABLE "collection_request_requirements" ADD COLUMN "semantic_spec" jsonb;--> statement-breakpoint
ALTER TABLE "service_document_requirements" ADD COLUMN "semantic_spec" jsonb;--> statement-breakpoint
ALTER TABLE "service_document_requirements" ADD COLUMN "required_count" integer DEFAULT 1 NOT NULL;