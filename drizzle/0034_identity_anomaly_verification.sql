ALTER TYPE "public"."document_status" ADD VALUE 'identity_anomaly_pending_confirmation';--> statement-breakpoint
ALTER TYPE "public"."document_status" ADD VALUE 'identity_anomaly_confirmed';--> statement-breakpoint
ALTER TYPE "public"."document_status" ADD VALUE 'identity_anomaly_rejected';--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extracted_person_name" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extracted_id_number" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extracted_company_name" text;