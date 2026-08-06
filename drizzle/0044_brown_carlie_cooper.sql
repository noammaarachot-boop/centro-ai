ALTER TYPE "public"."document_status" ADD VALUE 'superseded';--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "superseded_by_document_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_superseded_by_document_id_documents_id_fk" FOREIGN KEY ("superseded_by_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;