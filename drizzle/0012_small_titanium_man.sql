CREATE TABLE "document_learned_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"source_requirement_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_learned_patterns" ADD CONSTRAINT "document_learned_patterns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_learned_patterns" ADD CONSTRAINT "document_learned_patterns_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_learned_patterns" ADD CONSTRAINT "document_learned_patterns_source_requirement_id_service_document_requirements_id_fk" FOREIGN KEY ("source_requirement_id") REFERENCES "public"."service_document_requirements"("id") ON DELETE cascade ON UPDATE no action;