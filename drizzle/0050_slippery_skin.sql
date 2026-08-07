CREATE TYPE "public"."webhook_claim_status" AS ENUM('processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "webhook_message_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"whatsapp_message_id" text NOT NULL,
	"status" "webhook_claim_status" DEFAULT 'processing' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_message_claims_whatsapp_message_id_idx" ON "webhook_message_claims" USING btree ("whatsapp_message_id");