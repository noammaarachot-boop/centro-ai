CREATE TYPE "public"."support_request_category" AS ENUM('not_working', 'google_drive', 'whatsapp', 'question', 'feature_request', 'other');--> statement-breakpoint
CREATE TYPE "public"."support_request_delivery_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "support_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_number" serial NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"user_name" text,
	"user_email" text NOT NULL,
	"organization_name" text NOT NULL,
	"category" "support_request_category" NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"current_page" text,
	"timezone" text,
	"delivery_status" "support_request_delivery_status" DEFAULT 'pending' NOT NULL,
	"email_sent_at" timestamp with time zone,
	"email_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;