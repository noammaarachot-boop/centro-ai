CREATE TYPE "public"."platform_owner_audit_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TABLE "platform_owner_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" text NOT NULL,
	"severity" "platform_owner_audit_severity" DEFAULT 'info' NOT NULL,
	"platform_owner_id" uuid,
	"description" text NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "platform_owner_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform_owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_owners_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "platform_owner_audit_log" ADD CONSTRAINT "platform_owner_audit_log_platform_owner_id_platform_owners_id_fk" FOREIGN KEY ("platform_owner_id") REFERENCES "public"."platform_owners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_owner_sessions" ADD CONSTRAINT "platform_owner_sessions_platform_owner_id_platform_owners_id_fk" FOREIGN KEY ("platform_owner_id") REFERENCES "public"."platform_owners"("id") ON DELETE cascade ON UPDATE no action;