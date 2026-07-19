CREATE TABLE "business_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"service_id" uuid NOT NULL,
	"is_custom" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "business_type_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "onboarding_step" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "logo_url" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "reminder_interval_days_override" integer;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "inactivity_timeout_minutes_override" integer;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "business_hours_start_override" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "business_hours_end_override" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "business_days_override" text;--> statement-breakpoint
ALTER TABLE "business_types" ADD CONSTRAINT "business_types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_types" ADD CONSTRAINT "business_types_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_business_type_id_business_types_id_fk" FOREIGN KEY ("business_type_id") REFERENCES "public"."business_types"("id") ON DELETE set null ON UPDATE no action;