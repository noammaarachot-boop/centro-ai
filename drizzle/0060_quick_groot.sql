CREATE TYPE "public"."conversation_focus_source" AS ENUM('single_open_request', 'disambiguation_reply', 'explicit_switch');--> statement-breakpoint
CREATE TABLE "client_conversation_focus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"collection_request_id" uuid NOT NULL,
	"source" "conversation_focus_source" NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_conversation_focus" ADD CONSTRAINT "client_conversation_focus_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_conversation_focus" ADD CONSTRAINT "client_conversation_focus_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_conversation_focus" ADD CONSTRAINT "client_conversation_focus_collection_request_id_collection_requests_id_fk" FOREIGN KEY ("collection_request_id") REFERENCES "public"."collection_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_conversation_focus_client_idx" ON "client_conversation_focus" USING btree ("client_id");