CREATE TABLE "pending_request_disambiguations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"candidate_collection_request_ids" jsonb NOT NULL,
	"host_conversation_id" uuid NOT NULL,
	"message_body" text,
	"pending_file_name" text,
	"pending_file_content" "bytea",
	"pending_file_mime_type" text,
	"whatsapp_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_collection_request_id" uuid
);
--> statement-breakpoint
ALTER TABLE "pending_request_disambiguations" ADD CONSTRAINT "pending_request_disambiguations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_request_disambiguations" ADD CONSTRAINT "pending_request_disambiguations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_request_disambiguations" ADD CONSTRAINT "pending_request_disambiguations_host_conversation_id_conversations_id_fk" FOREIGN KEY ("host_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_request_disambiguations" ADD CONSTRAINT "pending_request_disambiguations_resolved_collection_request_id_collection_requests_id_fk" FOREIGN KEY ("resolved_collection_request_id") REFERENCES "public"."collection_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pending_request_disambiguations_client_open_idx" ON "pending_request_disambiguations" USING btree ("client_id") WHERE "pending_request_disambiguations"."resolved_at" is null;