CREATE TYPE "public"."client_document_requirement_action" AS ENUM('add', 'remove');--> statement-breakpoint
CREATE TYPE "public"."client_document_requirement_status" AS ENUM('pending', 'confirmed', 'declined');--> statement-breakpoint
CREATE TABLE "client_document_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"action" "client_document_requirement_action" NOT NULL,
	"name" text NOT NULL,
	"source_requirement_id" uuid,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"status" "client_document_requirement_status" DEFAULT 'pending' NOT NULL,
	"pending_confirmation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_document_requirements" ADD CONSTRAINT "client_document_requirements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_document_requirements" ADD CONSTRAINT "client_document_requirements_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_document_requirements" ADD CONSTRAINT "client_document_requirements_source_requirement_id_service_document_requirements_id_fk" FOREIGN KEY ("source_requirement_id") REFERENCES "public"."service_document_requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_document_requirements" ADD CONSTRAINT "client_document_requirements_pending_confirmation_id_pending_confirmations_id_fk" FOREIGN KEY ("pending_confirmation_id") REFERENCES "public"."pending_confirmations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_document_requirements_client_name_action_idx" ON "client_document_requirements" USING btree ("client_id","name","action");