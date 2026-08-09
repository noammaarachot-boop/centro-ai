CREATE TYPE "public"."review_item_category" AS ENUM('missing_document', 'alternative_or_policy_question', 'human_request', 'other');--> statement-breakpoint
CREATE TYPE "public"."review_item_status" AS ENUM('pending', 'resolved');--> statement-breakpoint
ALTER TYPE "public"."document_status" ADD VALUE 'human_control_pending';--> statement-breakpoint
CREATE TABLE "approved_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"question_summary" text NOT NULL,
	"decision_text" text NOT NULL,
	"related_document_type" text,
	"category" "review_item_category" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"source_review_item_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "employee_review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"collection_request_id" uuid,
	"conversation_id" uuid NOT NULL,
	"client_question" text NOT NULL,
	"category" "review_item_category" NOT NULL,
	"understood_context" jsonb,
	"related_requirement_id" uuid,
	"status" "review_item_status" DEFAULT 'pending' NOT NULL,
	"resolution_text" text,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"became_policy" boolean DEFAULT false NOT NULL,
	"policy_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approved_policies" ADD CONSTRAINT "approved_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_policies" ADD CONSTRAINT "approved_policies_source_review_item_id_employee_review_items_id_fk" FOREIGN KEY ("source_review_item_id") REFERENCES "public"."employee_review_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_policies" ADD CONSTRAINT "approved_policies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_policies" ADD CONSTRAINT "approved_policies_retired_by_user_id_users_id_fk" FOREIGN KEY ("retired_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_review_items" ADD CONSTRAINT "employee_review_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_review_items" ADD CONSTRAINT "employee_review_items_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_review_items" ADD CONSTRAINT "employee_review_items_collection_request_id_collection_requests_id_fk" FOREIGN KEY ("collection_request_id") REFERENCES "public"."collection_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_review_items" ADD CONSTRAINT "employee_review_items_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_review_items" ADD CONSTRAINT "employee_review_items_related_requirement_id_collection_request_requirements_id_fk" FOREIGN KEY ("related_requirement_id") REFERENCES "public"."collection_request_requirements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_review_items" ADD CONSTRAINT "employee_review_items_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;