CREATE TYPE "public"."pending_confirmation_status" AS ENUM('pending', 'confirmed', 'declined');--> statement-breakpoint
CREATE TABLE "pending_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"collection_request_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb,
	"question" text NOT NULL,
	"status" "pending_confirmation_status" DEFAULT 'pending' NOT NULL,
	"response_text" text,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_confirmations" ADD CONSTRAINT "pending_confirmations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_confirmations" ADD CONSTRAINT "pending_confirmations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_confirmations" ADD CONSTRAINT "pending_confirmations_collection_request_id_collection_requests_id_fk" FOREIGN KEY ("collection_request_id") REFERENCES "public"."collection_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_confirmations" ADD CONSTRAINT "pending_confirmations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;